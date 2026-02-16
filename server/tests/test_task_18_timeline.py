# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.testclient import WebSocketTestSession

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


def _parse_created_at_z(s: str) -> datetime:
    assert s.endswith("Z"), f"expected created_at to end with Z, got: {s!r}"
    return datetime.fromisoformat(s[:-1] + "+00:00")


def _timeline_list(
    client: TestClient,
    *,
    headers: dict[str, str],
    save_id: str,
    cursor: str,
    limit: int,
    event_type: str | None = None,
) -> dict[str, object]:
    params: dict[str, str] = {
        "save_id": save_id,
        "cursor": cursor,
        "limit": str(limit),
    }
    if isinstance(event_type, str) and event_type.strip() != "":
        params["event_type"] = event_type

    resp = client.get("/api/v1/timeline", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    body = cast(dict[str, object], resp.json())
    assert isinstance(body.get("items"), list)
    assert isinstance(body.get("next_cursor"), str)
    return body


def _assert_items_sorted(items: list[object]) -> None:
    prev: tuple[datetime, str] | None = None
    for raw in items:
        assert isinstance(raw, dict)
        it = cast(dict[str, object], raw)
        created_at_raw = it.get("created_at")
        event_id_raw = it.get("id")
        assert isinstance(created_at_raw, str)
        assert isinstance(event_id_raw, str)
        key = (_parse_created_at_z(created_at_raw), event_id_raw)
        if prev is not None:
            assert prev >= key, f"items not sorted desc: prev={prev!r} key={key!r}"
        prev = key


def _page_through(
    client: TestClient,
    *,
    headers: dict[str, str],
    save_id: str,
    limit: int,
    event_type: str | None = None,
    max_pages: int = 200,
) -> list[dict[str, object]]:
    cursor = "0"
    out: list[dict[str, object]] = []
    seen: set[str] = set()

    for _ in range(max_pages):
        body = _timeline_list(
            client,
            headers=headers,
            save_id=save_id,
            cursor=cursor,
            limit=limit,
            event_type=event_type,
        )
        items = cast(list[object], body["items"])
        _assert_items_sorted(items)

        for raw in items:
            assert isinstance(raw, dict)
            it = cast(dict[str, object], raw)
            raw_id = it.get("id")
            assert isinstance(raw_id, str)
            assert raw_id not in seen, f"duplicate id across pages: {raw_id!r}"
            seen.add(raw_id)
            out.append(it)

        next_cursor = cast(str, body["next_cursor"])
        if next_cursor == "":
            return out
        cursor = next_cursor

    raise AssertionError(f"did not finish pagination within max_pages={max_pages}")


def test_task_18_timeline_simulate_then_list_and_ws_replay() -> None:
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post(
            "/api/v1/saves",
            json={"name": "timeline-save"},
            headers=headers,
        )
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        simulate_resp = client.post(
            "/api/v1/timeline/simulate",
            json={
                "save_id": save_id,
                "event_type": "WALKED",
                "content": "I walked for 10 minutes",
            },
            headers=headers,
        )
        assert simulate_resp.status_code == 200, simulate_resp.text
        simulate_body = cast(dict[str, object], simulate_resp.json())
        assert isinstance(simulate_body.get("task_id"), str)

        list_resp = client.get(
            f"/api/v1/timeline?save_id={save_id}&cursor=0&limit=10",
            headers=headers,
        )
        assert list_resp.status_code == 200, list_resp.text
        list_body = cast(dict[str, object], list_resp.json())
        items = list_body.get("items")
        assert isinstance(items, list)
        item_dicts = [cast(dict[str, object], it) for it in items if isinstance(it, dict)]
        assert any(it.get("content") == "I walked for 10 minutes" for it in item_dicts)

        ws_url = f"/ws/v1?save_id={save_id}&resume_from=0"
        with client.websocket_connect(ws_url, headers=headers) as ws:
            _ = _recv_until_type(ws, "HELLO")
            frame = _recv_until_type(ws, "TIMELINE_EVENT")

        payload = frame.get("payload")
        assert isinstance(payload, dict)
        payload_dict = cast(dict[str, object], payload)
        assert payload_dict.get("event") == "TIMELINE_EVENT_CREATED"

        timeline_event = payload_dict.get("timeline_event")
        assert isinstance(timeline_event, dict)
        timeline_event_dict = cast(dict[str, object], timeline_event)
        assert timeline_event_dict.get("save_id") == save_id
        assert timeline_event_dict.get("event_type") == "WALKED"
        assert timeline_event_dict.get("content") == "I walked for 10 minutes"

        repo_root = Path(__file__).resolve().parents[2]
        evidence_path = repo_root / ".sisyphus" / "evidence" / "task-18-timeline.txt"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        seq = frame.get("seq")
        server_event_id = frame.get("server_event_id")
        evidence_lines = [
            "task-18 timeline evidence",
            f"save_id={save_id}",
            f"simulate_status={simulate_resp.status_code}",
            f"simulate_body={simulate_body}",
            f"list_status={list_resp.status_code}",
            f"list_body={list_body}",
            f"ws_frame_type={frame.get('type')}",
            f"ws_frame_seq={seq}",
            f"ws_frame_server_event_id={server_event_id}",
            f"ws_frame_payload={payload_dict}",
            "assert_db_list_contains_content=True",
            "assert_ws_replay_received=True",
            "",
        ]
        _ = evidence_path.write_text("\n".join(evidence_lines), encoding="utf-8")


def test_task_44_timeline_keyset_pagination_no_duplicates_no_skips_stable_order() -> None:
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post(
            "/api/v1/saves",
            json={"name": "timeline-save-keyset"},
            headers=headers,
        )
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        for i in range(37):
            event_type = "WALKED" if i % 2 == 0 else "ATE"
            resp = client.post(
                "/api/v1/timeline/simulate",
                json={
                    "save_id": save_id,
                    "event_type": event_type,
                    "content": f"evt-{i}",
                },
                headers=headers,
            )
            assert resp.status_code == 200, resp.text

        full_body = _timeline_list(
            client,
            headers=headers,
            save_id=save_id,
            cursor="0",
            limit=200,
        )
        full_items = cast(list[object], full_body["items"])
        _assert_items_sorted(full_items)
        expected_ids = [cast(str, cast(dict[str, object], it)["id"]) for it in full_items]

        paged = _page_through(
            client,
            headers=headers,
            save_id=save_id,
            limit=7,
        )
        paged_ids = [cast(str, it["id"]) for it in paged]

        assert paged_ids == expected_ids


def test_task_44_timeline_event_type_filter_paginates_stably() -> None:
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post(
            "/api/v1/saves",
            json={"name": "timeline-save-filter"},
            headers=headers,
        )
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        for i in range(29):
            event_type = "WALKED" if i % 3 != 0 else "SOCIAL"
            resp = client.post(
                "/api/v1/timeline/simulate",
                json={
                    "save_id": save_id,
                    "event_type": event_type,
                    "content": f"evt-{i}",
                },
                headers=headers,
            )
            assert resp.status_code == 200, resp.text

        filtered_full_body = _timeline_list(
            client,
            headers=headers,
            save_id=save_id,
            cursor="0",
            limit=200,
            event_type="WALKED",
        )
        filtered_full_items = cast(list[object], filtered_full_body["items"])
        _assert_items_sorted(filtered_full_items)
        assert all(
            isinstance(it, dict) and cast(dict[str, object], it).get("event_type") == "WALKED"
            for it in filtered_full_items
        )
        expected_ids = [cast(str, cast(dict[str, object], it)["id"]) for it in filtered_full_items]

        paged = _page_through(
            client,
            headers=headers,
            save_id=save_id,
            limit=4,
            event_type="WALKED",
        )
        paged_ids = [cast(str, it["id"]) for it in paged]
        assert paged_ids == expected_ids


def test_task_44_timeline_invalid_cursor_returns_400() -> None:
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post(
            "/api/v1/saves",
            json={"name": "timeline-save-bad-cursor"},
            headers=headers,
        )
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        resp = client.get(
            "/api/v1/timeline",
            params={"save_id": save_id, "cursor": "not-a-cursor", "limit": "10"},
            headers=headers,
        )
        assert resp.status_code == 400
