# pyright: reportMissingImports=false

from __future__ import annotations

import uuid
from typing import cast

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from app.core.config import settings
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


def _register(client: TestClient, *, email: str, password: str) -> TokenPair:
    return _register2(client, email=email, password=password, invite_code=None)


def _register2(
    client: TestClient,
    *,
    email: str,
    password: str,
    invite_code: str | None,
) -> TokenPair:
    body: dict[str, object] = {"email": email, "password": password}
    if isinstance(invite_code, str) and invite_code.strip() != "":
        body["invite_code"] = invite_code.strip()
    resp = client.post(
        "/api/v1/auth/register",
        json=body,
    )
    assert resp.status_code == 201, resp.text
    data = cast(TokenPair, resp.json())
    assert "access_token" in data
    assert "refresh_token" in data
    return data


def _admin_login(client: TestClient, *, email: str, password: str) -> str:
    r = client.post("/api/v1/admin/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    body = cast(dict[str, object], r.json())
    token = body.get("access_token")
    assert isinstance(token, str) and token
    return token


def _admin_create_invite(client: TestClient, *, admin_token: str, max_uses: int = 1) -> str:
    r = client.post(
        "/api/v1/admin/invites",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"max_uses": max_uses},
    )
    assert r.status_code == 201, r.text
    body = cast(dict[str, object], r.json())
    code = body.get("code")
    assert isinstance(code, str) and code
    return code


def _get_user_id(client: TestClient, *, access_token: str) -> str:
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


def test_task_2_3_ws_v1_rejects_connecting_to_non_owned_save() -> None:
    password = "password123"

    with TestClient(app) as client:
        email1 = _random_email()
        tokens1 = _register(client, email=email1, password=password)
        admin_token = _admin_login(client, email=email1, password=password)
        invite = _admin_create_invite(client, admin_token=admin_token, max_uses=1)
        tokens2 = _register2(client, email=_random_email(), password=password, invite_code=invite)

        access1 = tokens1["access_token"]
        access2 = tokens2["access_token"]

        _ = _get_user_id(client, access_token=access1)
        _ = _get_user_id(client, access_token=access2)

        headers1 = {"Authorization": f"Bearer {access1}"}
        headers2 = {"Authorization": f"Bearer {access2}"}
        save_id = _create_save_id(client, headers=headers1, name=f"save-{uuid.uuid4().hex}")

        url = f"/ws/v1?save_id={save_id}&resume_from=0"
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(url, headers=headers2):
                pass
        assert exc.value.code == 1008


def test_task_2_3_ws_v1_device_limit_rejects_new_device_but_allows_reconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ws_max_devices_per_save", 2)
    password = "password123"

    device_a = "dev-a"
    device_b = "dev-b"
    device_c = "dev-c"

    with TestClient(app) as client:
        tokens = _register(client, email=_random_email(), password=password)
        access = tokens["access_token"]

        _ = _get_user_id(client, access_token=access)
        headers = {"Authorization": f"Bearer {access}"}
        save_id = _create_save_id(client, headers=headers, name=f"save-{uuid.uuid4().hex}")

        url_a = f"/ws/v1?save_id={save_id}&resume_from=0&device_id={device_a}"
        url_b = f"/ws/v1?save_id={save_id}&resume_from=0&device_id={device_b}"
        url_c = f"/ws/v1?save_id={save_id}&resume_from=0&device_id={device_c}"

        with client.websocket_connect(url_a, headers=headers) as ws_a0:
            _ = _recv_until_type(ws_a0, "HELLO")

        with client.websocket_connect(url_b, headers=headers) as ws_b0:
            _ = _recv_until_type(ws_b0, "HELLO")

        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(url_c, headers=headers):
                pass
        assert exc.value.code == 1008

        with client.websocket_connect(url_a, headers=headers) as ws_a1:
            _ = _recv_until_type(ws_a1, "HELLO")
