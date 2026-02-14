# pyright: reportMissingImports=false

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
from app.ws.v1 import append_event


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


def _recv_event_frames(
    ws: WebSocketTestSession, expected_count: int
) -> tuple[list[int], list[str]]:
    seqs: list[int] = []
    server_event_ids: list[str] = []

    while len(server_event_ids) < expected_count:
        msg = cast(dict[str, object], ws.receive_json())
        if msg.get("type") != "EVENT":
            continue
        server_event_id = msg.get("server_event_id")
        if server_event_id is None:
            continue
        seq = msg.get("seq")
        assert isinstance(seq, int)
        seqs.append(seq)
        server_event_ids.append(cast(str, server_event_id))

    return seqs, server_event_ids


def _assert_strictly_continuous(seqs: list[int], *, start_seq: int) -> None:
    assert seqs, "expected at least one EVENT frame"
    assert seqs[0] == start_seq
    for i in range(1, len(seqs)):
        assert seqs[i] == seqs[i - 1] + 1


def test_ws_v1_resume_reconnect_seq_continuous_and_event_id_unique_writes_evidence() -> None:
    email = _random_email()
    password = "password123"
    save_id = f"save-{uuid.uuid4().hex}"

    initial_n = 4
    extra_m = 3

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        user_id = _get_user_id(client, access_token=access)

        stream_key = (user_id, save_id)

        for i in range(initial_n):
            _ = append_event(stream_key, payload={"phase": "first", "i": i}, ack_required=True)

        url1 = f"/ws/v1?save_id={save_id}&resume_from=0"
        headers = {"Authorization": f"Bearer {access}"}
        with client.websocket_connect(url1, headers=headers) as ws1:
            seqs1, ids1 = _recv_event_frames(ws1, expected_count=initial_n)

        resume_from = seqs1[-1]

        for i in range(extra_m):
            _ = append_event(stream_key, payload={"phase": "second", "i": i}, ack_required=True)

        url2 = f"/ws/v1?save_id={save_id}&resume_from={resume_from}"
        with client.websocket_connect(url2, headers=headers) as ws2:
            seqs2, ids2 = _recv_event_frames(ws2, expected_count=extra_m)

        assert seqs2[0] == resume_from + 1

        _assert_strictly_continuous(seqs1, start_seq=1)
        _assert_strictly_continuous(seqs2, start_seq=resume_from + 1)

        assert set(ids1).isdisjoint(set(ids2))

        repo_root = Path(__file__).resolve().parents[2]
        evidence_path = repo_root / ".sisyphus" / "evidence" / "task-7-ws-resume.txt"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        evidence_lines = [
            "task-7 ws v1 resume evidence",
            f"user_id={user_id}",
            f"save_id={save_id}",
            f"resume_from={resume_from}",
            f"seqs_conn1={seqs1}",
            f"seqs_conn2={seqs2}",
            f"server_event_ids_conn1={ids1}",
            f"server_event_ids_conn2={ids2}",
            f"assert_seqs_continuous_conn1=True",
            f"assert_seqs_continuous_conn2=True",
            f"assert_server_event_id_unique=True",
            "",
        ]
        _ = evidence_path.write_text("\n".join(evidence_lines), encoding="utf-8")
