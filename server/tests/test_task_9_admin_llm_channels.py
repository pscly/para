# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import socket
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast, override

from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminKV, AdminLLMChannel, AdminUser, AuditLog
from app.db.session import SessionLocal, engine
from app.main import app


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


def _random_email() -> str:
    return f"admin-{uuid.uuid4().hex}@example.com"


def _create_admin(*, role: str, password: str) -> AdminUser:
    with SessionLocal() as db:
        admin = AdminUser(
            email=_random_email(),
            password_hash=hash_password(password),
            role=role,
            is_active=True,
        )
        db.add(admin)
        db.commit()
        db.refresh(admin)
        return admin


def _admin_login(client: TestClient, *, email: str, password: str) -> str:
    resp = client.post(
        "/api/v1/admin/auth/login",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 200, resp.text
    data = cast(dict[str, object], resp.json())
    assert data.get("token_type") == "bearer"
    token = data.get("access_token")
    assert isinstance(token, str) and token != ""
    return token


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        sockname = cast(tuple[str, int], s.getsockname())
        return sockname[1]
    finally:
        s.close()


def _start_models_stub(*, expected_bearer: str) -> tuple[ThreadingHTTPServer, str]:
    class _Handler(BaseHTTPRequestHandler):
        protocol_version: str = "HTTP/1.1"

        @override
        def log_message(self, format: str, *args: object) -> None:  # noqa: A003
            return

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/v1/models":
                self.send_response(404)
                self.end_headers()
                return
            auth = self.headers.get("Authorization")
            if auth != expected_bearer:
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                body = b'{"error":"unauthorized"}'
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                _ = self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            body = b'{"data":[],"object":"list"}'
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            _ = self.wfile.write(body)

    port = _free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, f"http://127.0.0.1:{port}"


def test_task_9_admin_llm_channels_crud_rbac_audit_and_connectivity() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    op_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)
    operator = _create_admin(role="operator", password=op_pw)

    api_key = f"test-key-{uuid.uuid4().hex}"
    stub_server, stub_base_url = _start_models_stub(expected_bearer=f"Bearer {api_key}")
    try:
        with TestClient(app) as client:
            super_token = _admin_login(client, email=super_admin.email, password=super_pw)
            super_headers = {"Authorization": f"Bearer {super_token}"}

            op_token = _admin_login(client, email=operator.email, password=op_pw)
            op_headers = {"Authorization": f"Bearer {op_token}"}

            empty_list = client.get("/api/v1/admin/llm/channels", headers=op_headers)
            assert empty_list.status_code == 200, empty_list.text
            empty_data = cast(dict[str, object], empty_list.json())
            assert empty_data.get("items") == []

            bad_base_url = client.post(
                "/api/v1/admin/llm/channels",
                headers=super_headers,
                json={
                    "name": "bad-base-url",
                    "base_url": "not-a-url",
                    "api_key": api_key,
                    "enabled": True,
                    "purpose": "chat",
                    "default_model": "gpt-test",
                    "timeout_ms": 1000,
                    "weight": 100,
                },
            )
            assert bad_base_url.status_code == 400, bad_base_url.text
            bad_body = cast(dict[str, object], bad_base_url.json())
            assert bad_body.get("detail") == "base_url_invalid"

            op_create = client.post(
                "/api/v1/admin/llm/channels",
                headers=op_headers,
                json={
                    "name": "ch1",
                    "base_url": stub_base_url,
                    "api_key": api_key,
                    "enabled": True,
                    "purpose": "chat",
                    "default_model": "gpt-test",
                    "timeout_ms": 1000,
                    "weight": 100,
                },
            )
            assert op_create.status_code == 403, op_create.text

            created = client.post(
                "/api/v1/admin/llm/channels",
                headers=super_headers,
                json={
                    "name": "ch1",
                    "base_url": stub_base_url,
                    "api_key": api_key,
                    "enabled": True,
                    "purpose": "chat",
                    "default_model": "gpt-test",
                    "timeout_ms": 1000,
                    "weight": 100,
                },
            )
            assert created.status_code == 201, created.text
            ch = cast(dict[str, object], created.json())
            assert isinstance(ch.get("id"), str) and ch["id"]
            assert ch.get("name") == "ch1"
            assert ch.get("base_url") == f"{stub_base_url}/v1"
            assert ch.get("api_key_present") is True
            assert isinstance(ch.get("api_key_masked"), str) and ch["api_key_masked"]
            assert "api_key" not in ch

            channel_id = cast(str, ch["id"])

            get_as_op = client.get(f"/api/v1/admin/llm/channels/{channel_id}", headers=op_headers)
            assert get_as_op.status_code == 200, get_as_op.text
            got = cast(dict[str, object], get_as_op.json())
            assert got.get("api_key_present") is True
            assert isinstance(got.get("api_key_masked"), str)
            assert "api_key" not in got

            test_resp = client.post(
                f"/api/v1/admin/llm/channels/{channel_id}:test", headers=op_headers
            )
            assert test_resp.status_code == 200, test_resp.text
            test_body = cast(dict[str, object], test_resp.json())
            assert test_body.get("ok") is True
            assert isinstance(test_body.get("latency_ms"), int)
            assert test_body.get("detail") == "ok"

            bad_clear = client.patch(
                f"/api/v1/admin/llm/channels/{channel_id}",
                headers=super_headers,
                json={"api_key": ""},
            )
            assert bad_clear.status_code == 400, bad_clear.text

            patch = client.patch(
                f"/api/v1/admin/llm/channels/{channel_id}",
                headers=super_headers,
                json={"weight": 200},
            )
            assert patch.status_code == 200, patch.text
            patched = cast(dict[str, object], patch.json())
            assert patched.get("weight") == 200
            assert patched.get("api_key_present") is True
            assert "api_key" not in patched

            r_get = client.get("/api/v1/admin/llm/routing", headers=op_headers)
            assert r_get.status_code == 200, r_get.text

            op_put = client.put(
                "/api/v1/admin/llm/routing",
                headers=op_headers,
                json={"default_chat_channel_id": channel_id},
            )
            assert op_put.status_code == 403, op_put.text

            put = client.put(
                "/api/v1/admin/llm/routing",
                headers=super_headers,
                json={"default_chat_channel_id": channel_id},
            )
            assert put.status_code == 200, put.text
            put_body = cast(dict[str, object], put.json())
            assert put_body.get("default_chat_channel_id") == channel_id

            d = client.delete(f"/api/v1/admin/llm/channels/{channel_id}", headers=super_headers)
            assert d.status_code == 200, d.text

        with SessionLocal() as db:
            row = db.get(AdminLLMChannel, channel_id)
            assert row is None

            kv = db.execute(
                select(AdminKV).where(AdminKV.namespace == "llm_routing", AdminKV.key == "global")
            ).scalar_one_or_none()
            assert kv is not None
            assert "default_chat_channel_id" in kv.value_json

            logs = (
                db.execute(
                    select(AuditLog)
                    .where(AuditLog.actor == f"admin:{super_admin.id}")
                    .order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
                )
                .scalars()
                .all()
            )
            actions = [l.action for l in logs]
            assert "llm_channel.create" in actions
            assert "llm_channel.update" in actions
            assert "llm_routing.update" in actions

            op_logs = (
                db.execute(
                    select(AuditLog)
                    .where(AuditLog.actor == f"admin:{operator.id}")
                    .order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
                )
                .scalars()
                .all()
            )
            op_actions = [l.action for l in op_logs]
            assert "llm_channel.test" in op_actions
    finally:
        stub_server.shutdown()
