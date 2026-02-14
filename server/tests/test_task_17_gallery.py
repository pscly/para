# pyright: reportMissingImports=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false

from __future__ import annotations

import uuid
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text

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


def test_task_17_gallery_generate_complete_list_writes_files() -> None:
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post("/api/v1/saves", json={"name": "gallery-save"}, headers=headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        gen_resp = client.post(
            "/api/v1/gallery/generate",
            json={"save_id": save_id, "prompt": "a tiny memory capsule"},
            headers=headers,
        )
        assert gen_resp.status_code == 201, gen_resp.text
        gen_body = cast(dict[str, object], gen_resp.json())

        gallery_id = cast(str, gen_body.get("gallery_id"))
        assert isinstance(gallery_id, str) and gallery_id
        assert cast(str, gen_body.get("status")) in {"pending", "completed", "failed"}

        list_resp = client.get(f"/api/v1/gallery/items?save_id={save_id}", headers=headers)
        assert list_resp.status_code == 200, list_resp.text
        items = cast(list[dict[str, object]], list_resp.json())
        assert len(items) >= 1

        first = items[0]
        assert cast(str, first.get("id")) == gallery_id
        assert cast(str, first.get("status")) == "completed"

        thumb = first.get("thumb_data_url")
        image = first.get("image_data_url")
        assert isinstance(thumb, str) and thumb.startswith("data:image/png;base64,")
        assert isinstance(image, str) and image.startswith("data:image/png;base64,")

        repo_root = Path(__file__).resolve().parents[2]
        image_path = repo_root / "server" / ".data" / "gallery" / gallery_id / "image.png"
        thumb_path = repo_root / "server" / ".data" / "gallery" / gallery_id / "thumb.png"
        assert image_path.exists()
        assert thumb_path.exists()
        assert image_path.stat().st_size > 0
        assert thumb_path.stat().st_size > 0
