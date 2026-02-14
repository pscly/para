# pyright: reportMissingImports=false

from __future__ import annotations

import uuid
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.testclient import WebSocketTestSession

from app.db.base import Base
from app.db.models import Persona
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


def _collect_chat_text_until_done(ws: WebSocketTestSession) -> str:
    buf: list[str] = []
    for _ in range(200_000):
        msg = _recv_json_dict(ws)
        msg_type = msg.get("type")

        if msg_type == "CHAT_TOKEN":
            payload = msg.get("payload")
            assert isinstance(payload, dict)
            token = cast(dict[str, object], payload).get("token")
            assert isinstance(token, str)
            buf.append(token)
            continue

        if msg_type == "CHAT_DONE":
            return "".join(buf)

        continue

    raise AssertionError("did not reach CHAT_DONE within frame limit")


def test_task_9_save_isolation_rest_and_ws_writes_evidence() -> None:
    email = _random_email()
    password = "password123"

    persona_a_name = f"persona-a-{uuid.uuid4().hex}"
    persona_b_name = f"persona-b-{uuid.uuid4().hex}"

    with Session(engine) as db:
        persona_a = Persona(name=persona_a_name, prompt="A", version=1)
        persona_b = Persona(name=persona_b_name, prompt="B", version=1)
        db.add_all([persona_a, persona_b])
        db.commit()
        db.refresh(persona_a)
        db.refresh(persona_b)

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_a = client.post("/api/v1/saves", json={"name": "saveA"}, headers=headers)
        assert save_a.status_code == 201, save_a.text
        save_a_body = cast(dict[str, object], save_a.json())
        save_a_id = cast(str, save_a_body["id"])

        save_b = client.post("/api/v1/saves", json={"name": "saveB"}, headers=headers)
        assert save_b.status_code == 201, save_b.text
        save_b_body = cast(dict[str, object], save_b.json())
        save_b_id = cast(str, save_b_body["id"])

        bind_a = client.post(
            f"/api/v1/saves/{save_a_id}/persona",
            json={"persona_id": persona_a.id},
            headers=headers,
        )
        assert bind_a.status_code == 200, bind_a.text

        bind_b = client.post(
            f"/api/v1/saves/{save_b_id}/persona",
            json={"persona_id": persona_b.id},
            headers=headers,
        )
        assert bind_b.status_code == 200, bind_b.text

        listed = client.get("/api/v1/saves", headers=headers)
        assert listed.status_code == 200, listed.text
        items = cast(list[dict[str, object]], listed.json())
        assert len(items) == 2

        persona_by_save_id = {
            cast(str, it["id"]): cast(str | None, it.get("persona_id")) for it in items
        }
        assert persona_by_save_id.get(save_a_id) == persona_a.id
        assert persona_by_save_id.get(save_b_id) == persona_b.id

        url_a = f"/ws/v1?save_id={save_a_id}&resume_from=0"
        with client.websocket_connect(url_a, headers=headers) as ws_a:
            _ = _recv_until_type(ws_a, "HELLO")
            ws_a.send_json(
                {
                    "type": "CHAT_SEND",
                    "payload": {"text": "apple"},
                    "client_request_id": str(uuid.uuid4()),
                }
            )
            _ = _collect_chat_text_until_done(ws_a)

        url_b = f"/ws/v1?save_id={save_b_id}&resume_from=0"
        with client.websocket_connect(url_b, headers=headers) as ws_b:
            _ = _recv_until_type(ws_b, "HELLO")
            ws_b.send_json(
                {
                    "type": "CHAT_SEND",
                    "payload": {"text": "banana"},
                    "client_request_id": str(uuid.uuid4()),
                }
            )
            _ = _collect_chat_text_until_done(ws_b)

        with client.websocket_connect(url_a, headers=headers) as ws_a2:
            _ = _recv_until_type(ws_a2, "HELLO")
            replay_a = _collect_chat_text_until_done(ws_a2)
        with client.websocket_connect(url_b, headers=headers) as ws_b2:
            _ = _recv_until_type(ws_b2, "HELLO")
            replay_b = _collect_chat_text_until_done(ws_b2)

        assert "apple" in replay_a
        assert "banana" not in replay_a
        assert "banana" in replay_b
        assert "apple" not in replay_b

        repo_root = Path(__file__).resolve().parents[2]
        evidence_path = repo_root / ".sisyphus" / "evidence" / "task-9-save-isolation.txt"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        evidence_lines = [
            "task-9 save isolation evidence",
            f"save_a_id={save_a_id}",
            f"save_b_id={save_b_id}",
            f"persona_a_id={persona_a.id}",
            f"persona_b_id={persona_b.id}",
            f"replay_save_a_text={replay_a}",
            f"replay_save_b_text={replay_b}",
            "assert_replay_a_contains_apple=True",
            "assert_replay_a_contains_banana=False",
            "assert_replay_b_contains_banana=True",
            "assert_replay_b_contains_apple=False",
            "assert_conclusion_history_not_mixed=True",
            "",
        ]
        _ = evidence_path.write_text("\n".join(evidence_lines), encoding="utf-8")
