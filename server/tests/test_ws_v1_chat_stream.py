# pyright: reportMissingImports=false

from __future__ import annotations

import uuid
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.testclient import WebSocketTestSession

from app.db.base import Base
from app.db.session import engine
from app.main import app


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


def _get_user_id(client: TestClient, access_token: str) -> str:
    me = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert me.status_code == 200, me.text
    body = cast(dict[str, str], me.json())
    user_id = body["user_id"]
    assert isinstance(user_id, str)
    assert user_id
    return user_id


def _create_save_id(client: TestClient, *, headers: dict[str, str], name: str) -> str:
    r = client.post("/api/v1/saves", json={"name": name}, headers=headers)
    assert r.status_code == 201, r.text
    data = cast(dict[str, object], r.json())
    save_id = data.get("id")
    assert isinstance(save_id, str) and save_id
    return save_id


def _recv_json_dict(ws: WebSocketTestSession) -> dict[str, object]:
    raw = cast(object, ws.receive_json())
    assert isinstance(raw, dict), f"expected dict json frame, got: {type(raw)!r}"
    return cast(dict[str, object], raw)


def _recv_until_type(
    ws: WebSocketTestSession,
    expected_type: str,
    *,
    max_frames: int = 500,
) -> dict[str, object]:
    for _ in range(max_frames):
        msg = _recv_json_dict(ws)
        if msg.get("type") == expected_type:
            return msg
    raise AssertionError(f"did not receive type={expected_type!r} within {max_frames} frames")


def _assert_is_event_frame(msg: dict[str, object]) -> None:
    server_event_id = msg.get("server_event_id")
    assert isinstance(server_event_id, str)
    assert server_event_id

    seq = msg.get("seq")
    assert isinstance(seq, int)
    assert seq >= 1


def test_ws_v1_chat_stream_send_emits_tokens_then_done() -> None:
    email = _random_email()
    password = "password123"
    client_request_id = str(uuid.uuid4())

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]

        user_id = _get_user_id(client, access_token=access)
        assert user_id

        headers = {"Authorization": f"Bearer {access}"}
        save_id = _create_save_id(client, headers=headers, name=f"save-chat-{uuid.uuid4().hex}")
        url = f"/ws/v1?save_id={save_id}&resume_from=0"
        with client.websocket_connect(url, headers=headers) as ws:
            _ = _recv_until_type(ws, "HELLO")

            ws.send_json(
                {
                    "type": "CHAT_SEND",
                    "payload": {"text": "hello"},
                    "client_request_id": client_request_id,
                }
            )

            got_token = False
            got_done = False
            for _ in range(5_000):
                msg = _recv_json_dict(ws)
                msg_type = msg.get("type")

                if msg_type == "CHAT_TOKEN":
                    _assert_is_event_frame(msg)
                    got_token = True
                    continue

                if msg_type == "CHAT_DONE":
                    _assert_is_event_frame(msg)
                    payload = msg.get("payload")
                    assert isinstance(payload, dict)
                    payload_dict = cast(dict[str, object], payload)
                    assert payload_dict.get("interrupted") is False
                    assert payload_dict.get("client_request_id") == client_request_id
                    got_done = True
                    break
                continue

            assert got_token, "expected at least one CHAT_TOKEN frame"
            assert got_done, "expected final CHAT_DONE frame"


def test_ws_v1_chat_stream_interrupt_stops_and_done_interrupted_true() -> None:
    email = _random_email()
    password = "password123"
    client_request_id = str(uuid.uuid4())
    long_text = "x" * 20_000

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        user_id = _get_user_id(client, access_token=access)
        assert user_id

        headers = {"Authorization": f"Bearer {access}"}
        save_id = _create_save_id(client, headers=headers, name=f"save-chat-{uuid.uuid4().hex}")
        url = f"/ws/v1?save_id={save_id}&resume_from=0"
        with client.websocket_connect(url, headers=headers) as ws:
            _ = _recv_until_type(ws, "HELLO")

            ws.send_json(
                {
                    "type": "CHAT_SEND",
                    "payload": {"text": long_text},
                    "client_request_id": client_request_id,
                }
            )

            while True:
                msg = _recv_json_dict(ws)
                msg_type = msg.get("type")

                if msg_type == "CHAT_TOKEN":
                    _assert_is_event_frame(msg)
                    break

                if msg_type == "CHAT_DONE":
                    raise AssertionError("received CHAT_DONE before first CHAT_TOKEN")

                continue

            ws.send_json({"type": "INTERRUPT"})

            done = _recv_until_type(ws, "CHAT_DONE", max_frames=10_000)
            _assert_is_event_frame(done)
            payload = done.get("payload")
            assert isinstance(payload, dict)
            payload_dict = cast(dict[str, object], payload)
            assert payload_dict.get("client_request_id") == client_request_id
            assert payload_dict.get("interrupted") is True
