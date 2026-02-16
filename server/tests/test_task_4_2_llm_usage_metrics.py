# pyright: reportMissingImports=false

from __future__ import annotations

import time
import uuid
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from starlette.testclient import WebSocketTestSession

from app.db.base import Base
from app.db.models import AdminUser, LLMUsageEvent
from app.db.session import SessionLocal, engine
from app.main import app
from app.core.security import hash_password


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


TokenPair = dict[str, str]


def _random_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}@example.com"


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


def _create_save_id(client: TestClient, *, headers: dict[str, str], name: str) -> str:
    r = client.post("/api/v1/saves", json={"name": name}, headers=headers)
    assert r.status_code == 201, r.text
    data = cast(dict[str, object], r.json())
    save_id = data.get("id")
    assert isinstance(save_id, str) and save_id
    return save_id


def _recv_json_dict(ws: WebSocketTestSession) -> dict[str, object]:
    raw = cast(object, ws.receive_json())
    assert isinstance(raw, dict)
    return cast(dict[str, object], raw)


def _recv_until_type(
    ws: WebSocketTestSession, expected_type: str, *, max_frames: int = 2_000
) -> dict[str, object]:
    for _ in range(max_frames):
        msg = _recv_json_dict(ws)
        if msg.get("type") == expected_type:
            return msg
    raise AssertionError(f"did not receive type={expected_type!r} within {max_frames} frames")


def test_task_4_2_ws_chat_persists_llm_usage_row_and_metrics_exposed() -> None:
    email = _random_email("user")
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}
        save_id = _create_save_id(client, headers=headers, name=f"save-usage-{uuid.uuid4().hex}")

        url = f"/ws/v1?save_id={save_id}&resume_from=0"
        with client.websocket_connect(url, headers=headers) as ws:
            _ = _recv_until_type(ws, "HELLO")
            ws.send_json(
                {
                    "type": "CHAT_SEND",
                    "payload": {"text": "hello"},
                    "client_request_id": str(uuid.uuid4()),
                }
            )
            _ = _recv_until_type(ws, "CHAT_DONE", max_frames=50_000)

        usage: LLMUsageEvent | None = None
        deadline = time.time() + 2.0
        while time.time() < deadline:
            with SessionLocal() as db:
                usage = (
                    db.execute(
                        select(LLMUsageEvent)
                        .where(LLMUsageEvent.save_id == save_id)
                        .order_by(LLMUsageEvent.created_at.desc())
                        .limit(1)
                    )
                    .scalars()
                    .one_or_none()
                )
            if usage is not None:
                break
            time.sleep(0.05)

        assert usage is not None
        assert usage.provider
        assert usage.api
        assert usage.model
        assert usage.latency_ms >= 0
        assert usage.output_chunks >= 0
        assert usage.output_chars >= 0

        m = client.get("/metrics")
        assert m.status_code == 200, m.text
        body = m.text
        assert "para_llm_chat_stream_requests_total" in body
        assert "para_llm_chat_stream_latency_seconds" in body


def test_task_4_2_admin_metrics_summary_includes_llm_usage_fields() -> None:
    pw = f"pw-{uuid.uuid4().hex}"
    with SessionLocal() as db:
        admin = AdminUser(
            email=_random_email("admin"),
            password_hash=hash_password(pw),
            role="super_admin",
            is_active=True,
        )
        db.add(admin)
        db.commit()
        db.refresh(admin)

    with TestClient(app) as client:
        login = client.post("/api/v1/admin/auth/login", json={"email": admin.email, "password": pw})
        assert login.status_code == 200, login.text
        tok = cast(dict[str, object], login.json()).get("access_token")
        assert isinstance(tok, str) and tok

        r = client.get("/api/v1/admin/metrics/summary", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200, r.text
        body = cast(dict[str, object], r.json())

        keys = [
            "llm_chat_count_24h",
            "llm_chat_error_count_24h",
            "llm_chat_interrupted_count_24h",
            "llm_chat_latency_ms_avg_24h",
            "llm_chat_latency_ms_p50_24h",
            "llm_chat_latency_ms_p95_24h",
            "llm_chat_ttft_ms_avg_24h",
            "llm_chat_ttft_ms_p50_24h",
            "llm_chat_ttft_ms_p95_24h",
            "llm_chat_output_chunks_total_24h",
            "llm_chat_output_chars_total_24h",
            "llm_chat_prompt_tokens_total_24h",
            "llm_chat_completion_tokens_total_24h",
            "llm_chat_total_tokens_total_24h",
        ]
        for k in keys:
            assert k in body
            v = body[k]
            assert isinstance(v, int)
            assert v >= 0
