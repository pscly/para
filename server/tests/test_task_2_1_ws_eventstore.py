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


def _recv_json_dict(ws: WebSocketTestSession) -> dict[str, object]:
    msg = cast(object, ws.receive_json())
    assert isinstance(msg, dict)
    return cast(dict[str, object], msg)


def _recv_hello(ws: WebSocketTestSession) -> dict[str, object]:
    for _ in range(1000):
        msg = _recv_json_dict(ws)
        if msg.get("type") == "HELLO":
            return msg
    raise AssertionError("expected HELLO")


def _recv_pong(ws: WebSocketTestSession) -> dict[str, object]:
    for _ in range(1000):
        msg = _recv_json_dict(ws)
        if msg.get("type") == "PONG":
            return msg
    raise AssertionError("expected PONG")


def _ack_and_wait_cursor(ws: WebSocketTestSession, *, cursor: int) -> None:
    ws.send_json({"type": "ACK", "cursor": int(cursor)})
    ws.send_json({"type": "PING", "payload": {"probe": "ack"}})
    pong = _recv_pong(ws)
    assert pong.get("cursor") == int(cursor)


def _recv_event_frames(ws: WebSocketTestSession, expected_count: int) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for _ in range(50_000):
        if len(out) >= expected_count:
            return out
        msg = _recv_json_dict(ws)
        if msg.get("type") == "EVENT":
            out.append(msg)
    raise AssertionError(f"expected {expected_count} EVENT frames, got {len(out)}")


def _assert_is_event_frame(msg: dict[str, object]) -> None:
    seq = msg.get("seq")
    server_event_id = msg.get("server_event_id")
    assert isinstance(seq, int) and seq >= 1
    assert isinstance(server_event_id, str) and server_event_id


def test_ws_v1_eventstore_per_device_cursor_and_trim() -> None:
    email = _random_email()
    password = "password123"

    device_a = "dev-a"
    device_b = "dev-b"

    n = 5
    trim_to = 3

    with TestClient(app) as client:
        access = _register(client, email=email, password=password)
        user_id = _get_user_id(client, access_token=access)

        headers = {"Authorization": f"Bearer {access}"}
        save_id = _create_save_id(client, headers=headers, name=f"save-{uuid.uuid4().hex}")

        stream_key = (user_id, save_id)
        for i in range(n):
            _ = append_event(stream_key, payload={"i": i}, ack_required=True)

        url_a_hello = f"/ws/v1?save_id={save_id}&resume_from=999&device_id={device_a}"
        with client.websocket_connect(url_a_hello, headers=headers) as ws_a0:
            hello_a0 = _recv_hello(ws_a0)
            assert hello_a0.get("cursor") == 0

        url_b = f"/ws/v1?save_id={save_id}&resume_from=999&device_id={device_b}"
        with client.websocket_connect(url_b, headers=headers) as ws_b0:
            hello_b = _recv_hello(ws_b0)
            assert hello_b.get("cursor") == 0

        url_a = f"/ws/v1?save_id={save_id}&resume_from=0&device_id={device_a}"
        with client.websocket_connect(url_a, headers=headers) as ws_a1:
            hello = _recv_hello(ws_a1)
            assert hello.get("cursor") == 0

            frames = _recv_event_frames(ws_a1, expected_count=n)
            seqs: list[int] = []
            for f in frames:
                _assert_is_event_frame(f)
                seqs.append(cast(int, f["seq"]))
            assert seqs == list(range(1, n + 1))

            _ack_and_wait_cursor(ws_a1, cursor=trim_to)

        url_b_all = f"/ws/v1?save_id={save_id}&resume_from=0&device_id={device_b}"
        with client.websocket_connect(url_b_all, headers=headers) as ws_b_all:
            hello_b_all = _recv_hello(ws_b_all)
            assert hello_b_all.get("cursor") == 0
            frames_b = _recv_event_frames(ws_b_all, expected_count=n)
            for f in frames_b:
                _assert_is_event_frame(f)

            _ack_and_wait_cursor(ws_b_all, cursor=trim_to)

        with client.websocket_connect(url_a_hello, headers=headers) as ws_a_hello:
            hello_a = _recv_hello(ws_a_hello)
            assert hello_a.get("cursor") == trim_to

        url_a_trimmed = f"/ws/v1?save_id={save_id}&resume_from=0&device_id={device_a}"
        with client.websocket_connect(url_a_trimmed, headers=headers) as ws_a2:
            _ = _recv_hello(ws_a2)
            frames2 = _recv_event_frames(ws_a2, expected_count=n - trim_to)
            seqs2 = [cast(int, f["seq"]) for f in frames2]
            assert seqs2 == list(range(trim_to + 1, n + 1))

            for f in frames2:
                _assert_is_event_frame(f)

            ws_a2.send_json({"type": "ACK", "cursor": trim_to})

        with client.websocket_connect(url_a_trimmed, headers=headers) as ws_a3:
            _ = _recv_hello(ws_a3)
            frames3 = _recv_event_frames(ws_a3, expected_count=n - trim_to)
            seqs3 = [cast(int, f["seq"]) for f in frames3]
            assert seqs3 == list(range(trim_to + 1, n + 1))
