# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import uuid
from pathlib import Path
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


def _get_user_id(client: TestClient, *, access_token: str) -> str:
    headers = {"Authorization": f"Bearer {access_token}"}
    resp = client.get("/api/v1/auth/me", headers=headers)
    assert resp.status_code == 200, resp.text
    body = cast(dict[str, object], resp.json())
    user_id = body.get("user_id")
    assert isinstance(user_id, str) and user_id
    return user_id


def _recv_json_dict(ws: WebSocketTestSession) -> dict[str, object]:
    raw = cast(object, ws.receive_json())
    assert isinstance(raw, dict), f"expected dict json frame, got: {type(raw)!r}"
    return cast(dict[str, object], raw)


def _recv_until_type(
    ws: WebSocketTestSession,
    expected_type: str,
    *,
    max_frames: int = 10_000,
) -> dict[str, object]:
    for _ in range(max_frames):
        msg = _recv_json_dict(ws)
        if msg.get("type") == expected_type:
            return msg
    raise AssertionError(f"did not receive type={expected_type!r} within {max_frames} frames")


def _recv_until_room_event(
    ws: WebSocketTestSession,
    *,
    expected_event: str,
    expected_room_id: str,
    max_frames: int = 10_000,
) -> dict[str, object]:
    for _ in range(max_frames):
        msg = _recv_json_dict(ws)
        if msg.get("type") != "ROOM_EVENT":
            continue
        payload = msg.get("payload")
        if not isinstance(payload, dict):
            continue
        payload_dict = cast(dict[str, object], payload)
        if payload_dict.get("event") != expected_event:
            continue
        if payload_dict.get("room_id") != expected_room_id:
            continue
        return msg
    raise AssertionError(
        f"did not receive ROOM_EVENT payload.event={expected_event!r} room_id={expected_room_id!r}"
    )


def test_task_19_room_create_invite_join_ws_replay_writes_evidence() -> None:
    email1 = _random_email()
    email2 = _random_email()
    password = "password123"

    with TestClient(app) as client:
        t1 = _register(client, email=email1, password=password)
        t2 = _register(client, email=email2, password=password)

        access1 = t1["access_token"]
        access2 = t2["access_token"]
        headers1 = {"Authorization": f"Bearer {access1}"}
        headers2 = {"Authorization": f"Bearer {access2}"}

        user1_id = _get_user_id(client, access_token=access1)
        user2_id = _get_user_id(client, access_token=access2)

        save1_resp = client.post("/api/v1/saves", json={"name": "u1-save"}, headers=headers1)
        assert save1_resp.status_code == 201, save1_resp.text
        save1_id = cast(str, cast(dict[str, object], save1_resp.json())["id"])

        save2_resp = client.post("/api/v1/saves", json={"name": "u2-save"}, headers=headers2)
        assert save2_resp.status_code == 201, save2_resp.text
        save2_id = cast(str, cast(dict[str, object], save2_resp.json())["id"])

        create_resp = client.post(
            "/api/v1/social/rooms",
            json={"room_type": "social"},
            headers=headers1,
        )
        assert create_resp.status_code == 201, create_resp.text
        create_body = cast(dict[str, object], create_resp.json())
        room_id = create_body.get("id")
        assert isinstance(room_id, str) and room_id

        invite_resp = client.post(
            f"/api/v1/social/rooms/{room_id}/invite",
            json={"target_user_id": user2_id},
            headers=headers1,
        )
        assert invite_resp.status_code == 200, invite_resp.text
        invite_body = cast(dict[str, object], invite_resp.json())

        join_resp = client.post(
            f"/api/v1/social/rooms/{room_id}/join",
            headers=headers2,
        )
        assert join_resp.status_code == 200, join_resp.text
        join_body = cast(dict[str, object], join_resp.json())

        ws_url1 = f"/ws/v1?save_id={save1_id}&resume_from=0"
        with client.websocket_connect(ws_url1, headers=headers1) as ws1:
            _ = _recv_until_type(ws1, "HELLO")
            frame1 = _recv_until_room_event(
                ws1,
                expected_event="ROOM_JOINED",
                expected_room_id=room_id,
            )

        ws_url2 = f"/ws/v1?save_id={save2_id}&resume_from=0"
        with client.websocket_connect(ws_url2, headers=headers2) as ws2:
            _ = _recv_until_type(ws2, "HELLO")
            frame2 = _recv_until_room_event(
                ws2,
                expected_event="ROOM_JOINED",
                expected_room_id=room_id,
            )

        payload1 = frame1.get("payload")
        assert isinstance(payload1, dict)
        p1 = cast(dict[str, object], payload1)

        payload2 = frame2.get("payload")
        assert isinstance(payload2, dict)
        p2 = cast(dict[str, object], payload2)

        assert p1.get("actor_user_id") == user2_id
        assert p2.get("actor_user_id") == user2_id
        assert p1.get("target_user_id") == user2_id
        assert p2.get("target_user_id") == user2_id

        repo_root = Path(__file__).resolve().parents[2]
        evidence_path = repo_root / ".sisyphus" / "evidence" / "task-19-room-event.txt"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        evidence_lines = [
            "task-19 room event evidence",
            f"room_id={room_id}",
            f"user1_id={user1_id}",
            f"user2_id={user2_id}",
            f"save1_id={save1_id}",
            f"save2_id={save2_id}",
            f"create_status={create_resp.status_code}",
            f"create_body={create_body}",
            f"invite_status={invite_resp.status_code}",
            f"invite_body={invite_body}",
            f"join_status={join_resp.status_code}",
            f"join_body={join_body}",
            f"ws1_frame_type={frame1.get('type')}",
            f"ws1_frame_seq={frame1.get('seq')}",
            f"ws1_frame_server_event_id={frame1.get('server_event_id')}",
            f"ws1_frame_payload={p1}",
            f"ws2_frame_type={frame2.get('type')}",
            f"ws2_frame_seq={frame2.get('seq')}",
            f"ws2_frame_server_event_id={frame2.get('server_event_id')}",
            f"ws2_frame_payload={p2}",
            "assert_ws1_received_room_joined=True",
            "assert_ws2_received_room_joined=True",
            "",
        ]
        _ = evidence_path.write_text("\n".join(evidence_lines), encoding="utf-8")
