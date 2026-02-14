# pyright: reportMissingImports=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false

from __future__ import annotations

import uuid
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text

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
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 201, resp.text
    data = cast(TokenPair, resp.json())
    assert "access_token" in data
    assert "refresh_token" in data
    return data


def test_task_15_sensors_screenshot_minimal() -> None:
    email = _random_email()
    password = "password123"

    tiny_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII="

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post("/api/v1/saves", json={"name": "save-vision"}, headers=headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        ok_resp = client.post(
            "/api/v1/sensors/screenshot",
            json={
                "save_id": save_id,
                "image_base64": tiny_png_b64,
                "privacy_mode": "standard",
            },
            headers=headers,
        )
        assert ok_resp.status_code == 200, ok_resp.text
        ok_body = cast(dict[str, object], ok_resp.json())
        assert isinstance(ok_body.get("suggestion"), str)
        assert cast(str, ok_body["suggestion"]) != ""


def test_task_15_sensors_screenshot_requires_auth() -> None:
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/sensors/screenshot",
            json={"save_id": "does-not-matter", "image_base64": "AA=="},
        )
        assert resp.status_code == 401


def test_task_15_sensors_screenshot_save_ownership_404() -> None:
    email1 = _random_email()
    email2 = _random_email()
    password = "password123"

    tiny_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII="

    with TestClient(app) as client:
        tokens1 = _register(client, email=email1, password=password)
        tokens2 = _register(client, email=email2, password=password)

        headers1 = {"Authorization": f"Bearer {tokens1['access_token']}"}
        headers2 = {"Authorization": f"Bearer {tokens2['access_token']}"}

        save_resp = client.post("/api/v1/saves", json={"name": "save-owner"}, headers=headers1)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        resp = client.post(
            "/api/v1/sensors/screenshot",
            json={"save_id": save_id, "image_base64": tiny_png_b64},
            headers=headers2,
        )
        assert resp.status_code == 404
