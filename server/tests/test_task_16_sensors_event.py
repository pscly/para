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


def _create_save(client: TestClient, *, headers: dict[str, str], name: str) -> str:
    resp = client.post("/api/v1/saves", json={"name": name}, headers=headers)
    assert resp.status_code == 201, resp.text
    data = cast(dict[str, object], resp.json())
    return cast(str, data["id"])


def test_task_16_sensors_event_clipboard_translation_200() -> None:
    email = _random_email()
    password = "password123"

    english_text = "This is a simple English sentence for translation."

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        save_id = _create_save(client, headers=headers, name="save-sensors-event")

        resp = client.post(
            "/api/v1/sensors/event",
            json={
                "save_id": save_id,
                "event_type": "clipboard",
                "text": english_text,
                "app_name": "test-app",
            },
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = cast(dict[str, object], resp.json())
        assert isinstance(body.get("suggestion"), str)
        assert cast(str, body["suggestion"]) != ""
        assert body.get("category") == "translation"


def test_task_16_sensors_event_idle_care_200() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        save_id = _create_save(client, headers=headers, name="save-sensors-idle")

        resp = client.post(
            "/api/v1/sensors/event",
            json={
                "save_id": save_id,
                "event_type": "idle",
                "idle_seconds": 120,
                "app_name": "test-app",
            },
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = cast(dict[str, object], resp.json())
        assert isinstance(body.get("suggestion"), str)
        assert cast(str, body["suggestion"]) != ""
        assert body.get("category") == "care"


def test_task_16_sensors_event_requires_auth_401() -> None:
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/sensors/event",
            json={
                "save_id": "does-not-matter",
                "event_type": "idle",
                "idle_seconds": 0,
            },
        )
        assert resp.status_code == 401


def test_task_16_sensors_event_save_ownership_404() -> None:
    email1 = _random_email()
    email2 = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens1 = _register(client, email=email1, password=password)
        tokens2 = _register(client, email=email2, password=password)

        headers1 = {"Authorization": f"Bearer {tokens1['access_token']}"}
        headers2 = {"Authorization": f"Bearer {tokens2['access_token']}"}

        save_id = _create_save(client, headers=headers1, name="save-owner")

        resp = client.post(
            "/api/v1/sensors/event",
            json={
                "save_id": save_id,
                "event_type": "clipboard",
                "text": "This should look like English text.",
            },
            headers=headers2,
        )
        assert resp.status_code == 404
