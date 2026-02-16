# pyright: reportMissingImports=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.base import Base
from app.db.session import engine
from app.main import app
from app.workers.celery_app import celery_app


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


TokenPair = dict[str, str]


def _random_email() -> str:
    return f"test-{uuid.uuid4().hex}@example.com"


def _register(client: TestClient, email: str, password: str) -> TokenPair:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 201, resp.text
    data = cast(TokenPair, resp.json())
    assert "access_token" in data
    assert "refresh_token" in data
    return data


def test_task_13_knowledge_upload_index_query_writes_evidence() -> None:
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    email = _random_email()
    password = "password123"

    content = """# Notes\n\nThis line is important: PARA_KNOWLEDGE_MAGIC_SENTENCE.\n\nMore text."""

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post("/api/v1/saves", json={"name": "save-know"}, headers=headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        upload_resp = client.post(
            "/api/v1/knowledge/materials",
            data={"save_id": save_id},
            files={"file": ("note.md", content.encode("utf-8"), "text/markdown")},
            headers=headers,
        )
        assert upload_resp.status_code == 201, upload_resp.text
        upload_body = cast(dict[str, object], upload_resp.json())
        material = cast(dict[str, object], upload_body["material"])
        material_id = cast(str, material["id"])

        assert cast(str, material["save_id"]) == save_id
        assert cast(str, material["status"]) == "pending"

        status_resp = client.get(f"/api/v1/knowledge/materials/{material_id}", headers=headers)
        assert status_resp.status_code == 200, status_resp.text
        status_body = cast(dict[str, object], status_resp.json())
        assert cast(str, status_body["status"]) == "indexed"

        query_resp = client.post(
            "/api/v1/knowledge/query",
            json={"save_id": save_id, "query": "PARA_KNOWLEDGE_MAGIC_SENTENCE", "top_k": 5},
            headers=headers,
        )
        assert query_resp.status_code == 200, query_resp.text
        query_body = cast(dict[str, object], query_resp.json())
        assert isinstance(query_body.get("answer"), str)
        assert "PARA_KNOWLEDGE_MAGIC_SENTENCE" in cast(str, query_body["answer"])

        citations = cast(list[dict[str, object]], query_body.get("citations"))
        assert len(citations) >= 1
        assert any(
            "PARA_KNOWLEDGE_MAGIC_SENTENCE" in cast(str, it.get("snippet", "")) for it in citations
        )

        repo_root = Path(__file__).resolve().parents[2]
        evidence_path = repo_root / ".sisyphus" / "evidence" / "task-13-knowledge-query.json"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        evidence = {
            "task": 13,
            "save_id": save_id,
            "upload": upload_body,
            "status": status_body,
            "query": query_body,
        }
        _ = evidence_path.write_text(
            json.dumps(evidence, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )


def test_task_45_knowledge_reindex_and_delete_closes_loop_writes_evidence() -> None:
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    email = _random_email()
    password = "password123"
    content = """# Notes\n\nThis line is important: PARA_KNOWLEDGE_MAGIC_SENTENCE.\n\nMore text."""

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post("/api/v1/saves", json={"name": "save-know-del"}, headers=headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        upload_resp = client.post(
            "/api/v1/knowledge/materials",
            data={"save_id": save_id},
            files={"file": ("note.md", content.encode("utf-8"), "text/markdown")},
            headers=headers,
        )
        assert upload_resp.status_code == 201, upload_resp.text
        upload_body = cast(dict[str, object], upload_resp.json())
        material = cast(dict[str, object], upload_body["material"])
        material_id = cast(str, material["id"])

        status_resp = client.get(f"/api/v1/knowledge/materials/{material_id}", headers=headers)
        assert status_resp.status_code == 200, status_resp.text
        status_body = cast(dict[str, object], status_resp.json())
        assert cast(str, status_body["status"]) == "indexed"

        query1_resp = client.post(
            "/api/v1/knowledge/query",
            json={"save_id": save_id, "query": "PARA_KNOWLEDGE_MAGIC_SENTENCE", "top_k": 5},
            headers=headers,
        )
        assert query1_resp.status_code == 200, query1_resp.text
        query1_body = cast(dict[str, object], query1_resp.json())
        assert "PARA_KNOWLEDGE_MAGIC_SENTENCE" in cast(str, query1_body["answer"])

        reindex_resp = client.post(
            f"/api/v1/knowledge/materials/{material_id}/reindex",
            headers=headers,
        )
        assert reindex_resp.status_code == 200, reindex_resp.text
        reindex_body = cast(dict[str, object], reindex_resp.json())

        status2_resp = client.get(f"/api/v1/knowledge/materials/{material_id}", headers=headers)
        assert status2_resp.status_code == 200, status2_resp.text
        status2_body = cast(dict[str, object], status2_resp.json())
        assert cast(str, status2_body["status"]) == "indexed"

        query_after_reindex_resp = client.post(
            "/api/v1/knowledge/query",
            json={"save_id": save_id, "query": "PARA_KNOWLEDGE_MAGIC_SENTENCE", "top_k": 5},
            headers=headers,
        )
        assert query_after_reindex_resp.status_code == 200, query_after_reindex_resp.text
        query_after_reindex_body = cast(dict[str, object], query_after_reindex_resp.json())
        assert "PARA_KNOWLEDGE_MAGIC_SENTENCE" in cast(str, query_after_reindex_body["answer"])

        delete_resp = client.delete(f"/api/v1/knowledge/materials/{material_id}", headers=headers)
        assert delete_resp.status_code == 200, delete_resp.text
        delete_body = cast(dict[str, object], delete_resp.json())

        status3_resp = client.get(f"/api/v1/knowledge/materials/{material_id}", headers=headers)
        assert status3_resp.status_code == 404, status3_resp.text

        query2_resp = client.post(
            "/api/v1/knowledge/query",
            json={"save_id": save_id, "query": "PARA_KNOWLEDGE_MAGIC_SENTENCE", "top_k": 5},
            headers=headers,
        )
        assert query2_resp.status_code == 200, query2_resp.text
        query2_body = cast(dict[str, object], query2_resp.json())
        assert "PARA_KNOWLEDGE_MAGIC_SENTENCE" not in cast(str, query2_body.get("answer", ""))
        citations2 = cast(list[dict[str, object]], query2_body.get("citations"))
        assert citations2 == []

        repo_root = Path(__file__).resolve().parents[2]
        evidence_path = repo_root / ".sisyphus" / "evidence" / "task-45-knowledge-delete.json"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        evidence = {
            "task": 45,
            "save_id": save_id,
            "material_id": material_id,
            "http": {
                "upload_status": upload_resp.status_code,
                "status_before_status": status_resp.status_code,
                "query_before_delete_status": query1_resp.status_code,
                "reindex_status": reindex_resp.status_code,
                "status_after_reindex_status": status2_resp.status_code,
                "query_after_reindex_status": query_after_reindex_resp.status_code,
                "delete_status": delete_resp.status_code,
                "get_after_delete_status": status3_resp.status_code,
                "query_after_delete_status": query2_resp.status_code,
            },
            "query_before_delete": query1_body,
            "reindex": reindex_body,
            "query_after_reindex": query_after_reindex_body,
            "delete": delete_body,
            "query_after_delete": query2_body,
        }
        _ = evidence_path.write_text(
            json.dumps(evidence, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )
