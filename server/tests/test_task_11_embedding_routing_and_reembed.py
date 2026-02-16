# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import json
import socket
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast, override

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.admin_secrets import encrypt_secret
from app.core.config import settings
from app.db.base import Base
from app.db.models import (
    AdminKV,
    AdminLLMChannel,
    KnowledgeChunk,
    KnowledgeMaterial,
    MemoryEmbedding,
)
from app.db.session import SessionLocal, engine
from app.main import app
from app.workers.tasks.embeddings import (
    task_11_reembed_knowledge_chunks,
    task_11_reembed_memory_embeddings,
)


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        sockname = cast(tuple[str, int], s.getsockname())
        return sockname[1]
    finally:
        s.close()


class _EmbeddingsStub:
    expected_bearer: str
    ok_request_count: int
    last_model: str | None

    def __init__(self, *, expected_bearer: str) -> None:
        self.expected_bearer = expected_bearer
        self.ok_request_count = 0
        self.last_model = None

    def start(self) -> tuple[ThreadingHTTPServer, str]:
        stub = self

        class _Handler(BaseHTTPRequestHandler):
            protocol_version: str = "HTTP/1.1"

            @override
            def log_message(self, format: str, *args: object) -> None:  # noqa: A003
                return

            def do_POST(self) -> None:  # noqa: N802
                if self.path != "/v1/embeddings":
                    self.send_response(404)
                    self.end_headers()
                    return

                auth = self.headers.get("Authorization")
                if auth != stub.expected_bearer:
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    body = b'{"error":"unauthorized"}'
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    _ = self.wfile.write(body)
                    return

                content_len = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(content_len)
                obj = cast(object, json.loads(raw.decode("utf-8")))
                assert isinstance(obj, dict)
                model = obj.get("model")
                inp = obj.get("input")
                assert isinstance(model, str) and model
                assert isinstance(inp, str)
                stub.last_model = model

                stub.ok_request_count += 1
                body = json.dumps({"data": [{"embedding": [1.0] * 128}]}).encode("utf-8")

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                _ = self.wfile.write(body)

        port = _free_port()
        server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        return server, f"http://127.0.0.1:{port}"


def _upsert_routing_kv(db: Session, *, embedding_channel_id: str | None) -> str | None:
    prev: str | None = None
    row = (
        db.execute(
            select(AdminKV).where(AdminKV.namespace == "llm_routing", AdminKV.key == "global")
        )
        .scalars()
        .one_or_none()
    )
    if row is not None:
        prev = row.value_json
        try:
            obj = cast(object, json.loads(row.value_json))
        except Exception:
            obj = {}
        if not isinstance(obj, dict):
            obj = {}
        d = cast(dict[str, object], obj)
        d["default_embedding_channel_id"] = embedding_channel_id
        row.value_json = json.dumps(d, ensure_ascii=True)
    else:
        row = AdminKV(
            namespace="llm_routing",
            key="global",
            value_json=json.dumps(
                {"default_embedding_channel_id": embedding_channel_id}, ensure_ascii=True
            ),
        )
        db.add(row)
    db.commit()
    return prev


def test_task_11_embedding_admin_routing_and_reembed_checkpointing() -> None:
    api_key = f"test-key-{uuid.uuid4().hex}"
    stub = _EmbeddingsStub(expected_bearer=f"Bearer {api_key}")
    stub_server, stub_base_url = stub.start()

    prev_provider = settings.knowledge_embedding_provider
    prev_base_url = settings.openai_base_url
    prev_api_key = settings.openai_api_key

    channel_id: str | None = None
    prev_kv: str | None = None
    try:
        settings.knowledge_embedding_provider = "openai"
        settings.openai_base_url = None
        settings.openai_api_key = None

        with SessionLocal() as db:
            _ = db.execute(text("DELETE FROM knowledge_chunks"))
            _ = db.execute(text("DELETE FROM knowledge_materials"))
            _ = db.execute(text("DELETE FROM memory_embeddings"))
            _ = db.execute(text("DELETE FROM memory_items"))
            db.commit()

            now = datetime.now(timezone.utc).replace(tzinfo=None)

            ch = AdminLLMChannel(
                name=f"emb-{uuid.uuid4().hex}",
                base_url=f"{stub_base_url}/v1",
                api_key_enc=encrypt_secret(api_key, key=settings.admin_secrets_master_key_bytes),
                enabled=True,
                purpose="embedding",
                default_model="text-embedding-stub",
                timeout_ms=5000,
                weight=100,
                created_at=now,
                updated_at=now,
            )
            db.add(ch)
            db.commit()
            db.refresh(ch)
            channel_id = ch.id
            prev_kv = _upsert_routing_kv(db, embedding_channel_id=ch.id)

        with TestClient(app) as client:
            email = f"user-{uuid.uuid4().hex}@example.com"
            password = "password123"
            reg = client.post("/api/v1/auth/register", json={"email": email, "password": password})
            assert reg.status_code == 201, reg.text
            reg_body = cast(dict[str, object], reg.json())
            access = cast(str, reg_body["access_token"])
            headers = {"Authorization": f"Bearer {access}"}

            save_resp = client.post("/api/v1/saves", json={"name": "save"}, headers=headers)
            assert save_resp.status_code == 201, save_resp.text
            save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

            r1 = client.post(
                "/api/v1/memory/ingest",
                json={"save_id": save_id, "content": "hello one"},
                headers=headers,
            )
            assert r1.status_code == 201, r1.text
            mem1 = cast(str, cast(dict[str, object], r1.json())["id"])

            r2 = client.post(
                "/api/v1/memory/ingest",
                json={"save_id": save_id, "content": "hello two"},
                headers=headers,
            )
            assert r2.status_code == 201, r2.text
            mem2 = cast(str, cast(dict[str, object], r2.json())["id"])

            s1 = client.get(
                "/api/v1/memory/search",
                params={"q": "hello", "save_id": save_id, "limit": 5},
                headers=headers,
            )
            assert s1.status_code == 200, s1.text

        with SessionLocal() as db:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            e1 = db.get(MemoryEmbedding, mem1)
            e2 = db.get(MemoryEmbedding, mem2)
            assert e1 is not None
            assert e2 is not None
            e1.embedding_model = "local-hash-v1"
            e1.embedding_dim = 64
            e1.embedding = [0.0] * 64
            e2.embedding_model = "local-hash-v1"
            e2.embedding_dim = 64
            e2.embedding = [0.0] * 64
            db.commit()

            m = KnowledgeMaterial(
                id=str(uuid.uuid4()),
                save_id=save_id,
                filename="a.txt",
                content_type="text/plain",
                storage_path="/tmp/unused",
                status="indexed",
                error=None,
                created_at=now,
                updated_at=now,
            )
            db.add(m)
            db.flush()
            ch1 = KnowledgeChunk(
                material_id=m.id,
                save_id=save_id,
                chunk_index=0,
                content="chunk one",
                embedding_model="local-hash-v1",
                embedding_dim=64,
                embedding=[0.0] * 64,
                created_at=now,
            )
            ch2 = KnowledgeChunk(
                material_id=m.id,
                save_id=save_id,
                chunk_index=1,
                content="chunk two",
                embedding_model="local-hash-v1",
                embedding_dim=64,
                embedding=[0.0] * 64,
                created_at=now,
            )
            db.add(ch1)
            db.add(ch2)
            db.commit()

        out1 = task_11_reembed_memory_embeddings(limit=1, force=False)
        assert out1.get("ok") is True
        assert out1.get("processed") == 1
        assert out1.get("updated") == 1
        nxt1 = cast(str | None, out1.get("next_start_after_memory_id"))
        assert isinstance(nxt1, str) and nxt1

        out2 = task_11_reembed_memory_embeddings(start_after_memory_id=nxt1, limit=10, force=False)
        assert out2.get("ok") is True
        assert out2.get("processed") == 1
        assert out2.get("updated") == 1

        out3 = task_11_reembed_memory_embeddings(
            start_after_memory_id=cast(str | None, out2.get("next_start_after_memory_id")),
            limit=10,
            force=False,
        )
        assert out3.get("ok") is True
        assert out3.get("processed") == 0

        with SessionLocal() as db:
            embs = cast(list[MemoryEmbedding], db.execute(select(MemoryEmbedding)).scalars().all())
            assert len(embs) == 2
            for e in embs:
                assert e.embedding_dim == 64
                assert isinstance(e.embedding_model, str)
                assert len(e.embedding_model) <= 50
                assert e.embedding_model.startswith("openai:")
                assert e.embedding_model.endswith(":fold64-v1")
                assert len(e.embedding) == 64

        k1 = task_11_reembed_knowledge_chunks(limit=1, force=False)
        assert k1.get("ok") is True
        assert k1.get("processed") == 1
        assert k1.get("updated") == 1
        knxt1 = cast(str | None, k1.get("next_start_after_chunk_id"))
        assert isinstance(knxt1, str) and knxt1

        k2 = task_11_reembed_knowledge_chunks(start_after_chunk_id=knxt1, limit=10, force=False)
        assert k2.get("ok") is True
        assert k2.get("processed") == 1
        assert k2.get("updated") == 1

        k3 = task_11_reembed_knowledge_chunks(
            start_after_chunk_id=cast(str | None, k2.get("next_start_after_chunk_id")),
            limit=10,
            force=False,
        )
        assert k3.get("ok") is True
        assert k3.get("processed") == 0

        with SessionLocal() as db:
            chunks = cast(list[KnowledgeChunk], db.execute(select(KnowledgeChunk)).scalars().all())
            assert len(chunks) == 2
            for c in chunks:
                assert c.embedding_dim == 64
                assert isinstance(c.embedding_model, str)
                assert len(c.embedding_model) <= 50
                assert c.embedding_model.startswith("openai:")
                assert c.embedding_model.endswith(":fold64-v1")
                assert len(c.embedding) == 64

        assert stub.ok_request_count >= 1
        assert stub.last_model == "text-embedding-stub"
    finally:
        settings.knowledge_embedding_provider = prev_provider
        settings.openai_base_url = prev_base_url
        settings.openai_api_key = prev_api_key
        stub_server.shutdown()

        with SessionLocal() as db:
            kv = (
                db.execute(
                    select(AdminKV).where(
                        AdminKV.namespace == "llm_routing", AdminKV.key == "global"
                    )
                )
                .scalars()
                .one_or_none()
            )
            if kv is not None:
                if prev_kv is not None:
                    kv.value_json = prev_kv
                else:
                    kv.value_json = "{}"
                db.commit()

            if channel_id is not None:
                ch_row = db.get(AdminLLMChannel, channel_id)
                if ch_row is not None:
                    db.delete(ch_row)
                    db.commit()
