# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import hashlib
import json
import uuid
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.core.config import settings
from app.db.base import Base
from app.db.models import AuditLog, PluginPackage
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


def test_task_21_plugins_upload_approve_list_download() -> None:
    email = _random_email()
    password = "password123"
    run_id = uuid.uuid4().hex
    plugin_id = f"hello-plugin-{run_id}"
    version = "0.0.1"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        authed = {"Authorization": f"Bearer {access}"}

        manifest_obj: dict[str, object] = {
            "id": plugin_id,
            "version": version,
            "name": "Hello Plugin",
            "entry": "index.js",
            "permissions": [],
        }
        manifest_json = json.dumps(manifest_obj, ensure_ascii=True)
        code = "export default function main(){return 'hello';}\n"
        expected_sha256 = hashlib.sha256(code.encode("utf-8")).hexdigest()

        upload_resp = client.post(
            "/api/v1/plugins",
            headers={"X-Admin-Secret": settings.admin_review_secret},
            json={"manifest_json": manifest_json, "code": code},
        )
        assert upload_resp.status_code == 201, upload_resp.text
        upload_body = cast(dict[str, object], upload_resp.json())
        assert upload_body.get("id") == plugin_id
        assert upload_body.get("version") == version
        assert upload_body.get("status") == "pending"
        assert upload_body.get("sha256") == expected_sha256

        list_before = client.get("/api/v1/plugins", headers=authed)
        assert list_before.status_code == 200, list_before.text
        items_before = cast(list[dict[str, object]], list_before.json())
        assert not any(it.get("id") == plugin_id for it in items_before)

        download_before = client.get(f"/api/v1/plugins/{plugin_id}/{version}", headers=authed)
        assert download_before.status_code == 404, download_before.text

        approve_resp = client.post(
            f"/api/v1/admin/review/plugins/{plugin_id}/{version}:approve",
            headers={"X-Admin-Secret": settings.admin_review_secret},
        )
        assert approve_resp.status_code == 200, approve_resp.text
        approve_body = cast(dict[str, object], approve_resp.json())
        assert approve_body.get("id") == plugin_id
        assert approve_body.get("version") == version
        assert approve_body.get("status") == "approved"

        list_after = client.get("/api/v1/plugins", headers=authed)
        assert list_after.status_code == 200, list_after.text
        items_after = cast(list[dict[str, object]], list_after.json())
        assert any(it.get("id") == plugin_id and it.get("version") == version for it in items_after)

        download_after = client.get(f"/api/v1/plugins/{plugin_id}/{version}", headers=authed)
        assert download_after.status_code == 200, download_after.text
        download_body = cast(dict[str, object], download_after.json())
        assert download_body.get("sha256") == expected_sha256
        assert download_body.get("code") == code

        canonical_manifest = json.dumps(
            manifest_obj,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
        assert download_body.get("manifest_json") == canonical_manifest

        with SessionLocal() as db:
            pkg = (
                db.execute(
                    select(PluginPackage).where(
                        PluginPackage.plugin_id == plugin_id,
                        PluginPackage.version == version,
                    )
                )
                .scalars()
                .one_or_none()
            )
            assert pkg is not None
            assert pkg.status == "approved"

            logs = list(
                db.execute(
                    select(AuditLog).where(
                        AuditLog.target_type == "plugin_package",
                        AuditLog.target_id == pkg.id,
                        AuditLog.action == "plugin.approve",
                    )
                )
                .scalars()
                .all()
            )
            assert len(logs) >= 1
