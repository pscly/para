# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import io
import json
import uuid
from pathlib import Path
from typing import cast

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlalchemy import text

import app.api.v1.knowledge as knowledge_api
import app.api.v1.ugc as ugc_api
from app.core.config import settings
from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminUser
from app.db.session import SessionLocal, engine
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


def _create_admin(*, role: str, password: str) -> AdminUser:
    with SessionLocal() as db:
        admin = AdminUser(
            email=_random_email(),
            password_hash=hash_password(password),
            role=role,
            is_active=True,
        )
        db.add(admin)
        db.commit()
        db.refresh(admin)
        return admin


def _admin_login(client: TestClient, *, email: str, password: str) -> str:
    resp = client.post(
        "/api/v1/admin/auth/login",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 200, resp.text
    data = cast(dict[str, object], resp.json())
    assert data.get("token_type") == "bearer"
    token = data.get("access_token")
    assert isinstance(token, str) and token != ""
    return token


def test_task_3_4_knowledge_upload_too_large_returns_413_and_cleans(
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(settings, "knowledge_materials_max_bytes", 8)
    monkeypatch.setattr(knowledge_api, "_server_data_dir", lambda: Path(tmp_path))

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        save_resp = client.post("/api/v1/saves", json={"name": "save-know"}, headers=headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        payload = b"x" * 32
        resp = client.post(
            "/api/v1/knowledge/materials",
            data={"save_id": save_id},
            files={"file": ("note.md", payload, "text/markdown")},
            headers=headers,
        )
        assert resp.status_code == 413, resp.text

    assert list(Path(tmp_path).iterdir()) == []


def test_task_3_4_ugc_upload_too_large_returns_413_and_cleans(
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(settings, "ugc_assets_max_bytes", 4)
    monkeypatch.setattr(settings, "ugc_assets_allowed_content_types", ["application/octet-stream"])
    monkeypatch.setattr(ugc_api, "_server_data_dir", lambda: Path(tmp_path))

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        resp = client.post(
            "/api/v1/ugc/assets",
            headers=headers,
            data={
                "asset_type": "test_asset",
                "manifest_json": json.dumps({"name": "t"}, ensure_ascii=True),
            },
            files={
                "file": (
                    "user.bin",
                    io.BytesIO(b"hello ugc"),
                    "application/octet-stream",
                )
            },
        )
        assert resp.status_code == 413, resp.text

    assert list(Path(tmp_path).iterdir()) == []


def test_task_3_4_ugc_upload_unsupported_content_type_returns_400(
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(settings, "ugc_assets_allowed_content_types", ["application/octet-stream"])
    monkeypatch.setattr(ugc_api, "_server_data_dir", lambda: Path(tmp_path))

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        resp = client.post(
            "/api/v1/ugc/assets",
            headers=headers,
            data={
                "asset_type": "test_asset",
                "manifest_json": json.dumps({"name": "t"}, ensure_ascii=True),
            },
            files={
                "file": (
                    "user.bin",
                    io.BytesIO(b"ok"),
                    "application/x-not-allowed",
                )
            },
        )
        assert resp.status_code == 400, resp.text

    assert list(Path(tmp_path).iterdir()) == []


def test_task_3_4_plugins_upload_payload_too_large_returns_413(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "plugins_upload_max_bytes", 16)

    with TestClient(app) as client:
        admin_pw = f"pw-{uuid.uuid4().hex}"
        admin = _create_admin(role="super_admin", password=admin_pw)
        token = _admin_login(client, email=admin.email, password=admin_pw)
        headers = {"Authorization": f"Bearer {token}"}

        manifest_obj: dict[str, object] = {
            "id": f"p-{uuid.uuid4().hex}",
            "version": "0.0.1",
            "name": "p",
            "entry": "index.js",
            "permissions": [],
        }
        manifest_json = json.dumps(manifest_obj, ensure_ascii=True)
        code = "x" * 64

        resp = client.post(
            "/api/v1/plugins",
            headers=headers,
            json={"manifest_json": manifest_json, "code": code},
        )
        assert resp.status_code == 413, resp.text
