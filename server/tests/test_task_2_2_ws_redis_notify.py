# pyright: reportMissingImports=false

from __future__ import annotations

import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.testclient import WebSocketTestSession

from app.db.base import Base
from app.db.session import engine
from app.main import app
from app.ws.v1 import append_event


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


def _random_email() -> str:
    return f"test-{uuid.uuid4().hex}@example.com"


def _register(client: TestClient, *, email: str, password: str) -> str:
    r = client.post("/api/v1/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    data = cast(dict[str, object], r.json())
    access = data.get("access_token")
    assert isinstance(access, str) and access
    return access


def _get_user_id(client: TestClient, *, access_token: str) -> str:
    r = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert r.status_code == 200, r.text
    data = cast(dict[str, object], r.json())
    user_id = data.get("user_id")
    assert isinstance(user_id, str) and user_id
    return user_id


def _create_save_id(client: TestClient, *, headers: dict[str, str], name: str) -> str:
    r = client.post("/api/v1/saves", json={"name": name}, headers=headers)
    assert r.status_code == 201, r.text
    data = cast(dict[str, object], r.json())
    save_id = data.get("id")
    assert isinstance(save_id, str) and save_id
    return save_id


def _recv_json_with_timeout(ws: WebSocketTestSession, *, timeout_s: float) -> dict[str, object]:
    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(ws.receive_json)
        raw = cast(object, fut.result(timeout=timeout_s))
    assert isinstance(raw, dict)
    return cast(dict[str, object], raw)


def _recv_until_type(
    ws: WebSocketTestSession,
    expected_type: str,
    *,
    max_frames: int = 2000,
    per_frame_timeout_s: float = 2.0,
) -> dict[str, object]:
    for _ in range(max_frames):
        msg = _recv_json_with_timeout(ws, timeout_s=per_frame_timeout_s)
        if msg.get("type") == expected_type:
            return msg
    raise AssertionError(f"did not receive type={expected_type!r} within {max_frames} frames")


def test_task_2_2_ws_redis_notify_tail_without_reconnect_receives_new_event() -> None:
    email = _random_email()
    password = "password123"
    nonce = uuid.uuid4().hex

    with TestClient(app) as client:
        access = _register(client, email=email, password=password)
        user_id = _get_user_id(client, access_token=access)

        headers = {"Authorization": f"Bearer {access}"}
        save_id = _create_save_id(client, headers=headers, name=f"save-{uuid.uuid4().hex}")
        url = f"/ws/v1?save_id={save_id}&resume_from=0"

        with client.websocket_connect(url, headers=headers) as ws:
            _ = _recv_until_type(ws, "HELLO")

            time.sleep(0.05)

            stream_key = (user_id, save_id)
            _ = append_event(
                stream_key, payload={"phase": "notify", "nonce": nonce}, ack_required=True
            )

            got = None
            for _ in range(2000):
                msg = _recv_json_with_timeout(ws, timeout_s=2.0)
                if msg.get("type") != "EVENT":
                    continue
                payload = msg.get("payload")
                if not isinstance(payload, dict):
                    continue
                payload_obj = cast(dict[str, object], payload)
                if payload_obj.get("phase") != "notify" or payload_obj.get("nonce") != nonce:
                    continue
                got = msg
                break

            assert got is not None, "expected EVENT frame from redis tail without reconnect"
            seq = got.get("seq")
            server_event_id = got.get("server_event_id")
            assert isinstance(seq, int) and seq >= 1
            assert isinstance(server_event_id, str) and server_event_id
