# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import hashlib
import io
import json
import uuid
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminUser, AuditLog, PluginPackage, UgcAsset
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
    body = cast(dict[str, object], resp.json())
    assert body.get("token_type") == "bearer"
    token = body.get("access_token")
    assert isinstance(token, str) and token != ""
    return token


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_task_5_2_admin_review_queue_list_detail_note_and_actions() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    op_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)
    operator = _create_admin(role="operator", password=op_pw)

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        op_token = _admin_login(client, email=operator.email, password=op_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}
        op_headers = {"Authorization": f"Bearer {op_token}"}

        tokens = _register(client, email=_random_email(), password="password123")
        user_headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        ugc_manifest = json.dumps({"name": "ugc-queue", "version": "0.0.1"}, ensure_ascii=True)
        ugc_upload = client.post(
            "/api/v1/ugc/assets",
            headers=user_headers,
            data={"asset_type": "test_asset", "manifest_json": ugc_manifest},
            files={"file": ("x.bin", io.BytesIO(b"ugc-bytes"), "application/octet-stream")},
        )
        assert ugc_upload.status_code == 201, ugc_upload.text
        ugc_body = cast(dict[str, object], ugc_upload.json())
        asset_id = ugc_body.get("id")
        assert isinstance(asset_id, str) and asset_id
        assert ugc_body.get("status") == "pending"

        plugin_id = f"plugin-{uuid.uuid4().hex}"
        version = "0.0.1"
        code = "export default function main(){return 'ok';}\n"
        expected_sha256 = _sha256_hex(code)
        plugin_manifest = json.dumps(
            {
                "id": plugin_id,
                "version": version,
                "name": "Queue Plugin",
                "entry": "index.js",
                "permissions": [],
            },
            ensure_ascii=True,
        )
        plugin_upload = client.post(
            "/api/v1/plugins",
            headers=super_headers,
            json={"manifest_json": plugin_manifest, "code": code},
        )
        assert plugin_upload.status_code == 201, plugin_upload.text
        plugin_body = cast(dict[str, object], plugin_upload.json())
        assert plugin_body.get("id") == plugin_id
        assert plugin_body.get("version") == version
        assert plugin_body.get("status") == "pending"
        assert plugin_body.get("sha256") == expected_sha256

        ugc_queue = client.get(
            "/api/v1/admin/review/ugc",
            params={"status": "pending", "limit": 50, "offset": 0},
            headers=op_headers,
        )
        assert ugc_queue.status_code == 200, ugc_queue.text
        ugc_queue_body = cast(dict[str, object], ugc_queue.json())
        ugc_items = cast(list[dict[str, object]], ugc_queue_body.get("items"))
        assert any(
            it.get("asset_id") == asset_id and it.get("status") == "pending" for it in ugc_items
        )

        ugc_detail = client.get(f"/api/v1/admin/review/ugc/{asset_id}", headers=op_headers)
        assert ugc_detail.status_code == 200, ugc_detail.text
        ugc_detail_body = cast(dict[str, object], ugc_detail.json())
        assert ugc_detail_body.get("asset_id") == asset_id
        manifest_raw = ugc_detail_body.get("manifest_json")
        assert isinstance(manifest_raw, str) and manifest_raw
        assert ugc_detail_body.get("manifest") == json.loads(manifest_raw)
        assert ugc_detail_body.get("reviewed_at") is None
        assert ugc_detail_body.get("reviewed_by") is None

        ugc_note_op = client.post(
            f"/api/v1/admin/review/ugc/{asset_id}:note",
            headers=op_headers,
            json={"note": "hi"},
        )
        assert ugc_note_op.status_code == 403, ugc_note_op.text

        note_text = "  looks good \n"
        ugc_note_super = client.post(
            f"/api/v1/admin/review/ugc/{asset_id}:note",
            headers=super_headers,
            json={"note": note_text},
        )
        assert ugc_note_super.status_code == 200, ugc_note_super.text
        ugc_note_body = cast(dict[str, object], ugc_note_super.json())
        assert ugc_note_body.get("review_note") == note_text.strip()

        ugc_approve = client.post(
            f"/api/v1/admin/review/ugc/{asset_id}:approve",
            headers=super_headers,
        )
        assert ugc_approve.status_code == 200, ugc_approve.text
        approve_body = cast(dict[str, object], ugc_approve.json())
        assert approve_body.get("asset_id") == asset_id
        assert approve_body.get("status") == "approved"

        plugin_queue = client.get(
            "/api/v1/admin/review/plugins",
            params={"status": "pending", "limit": 50, "offset": 0},
            headers=op_headers,
        )
        assert plugin_queue.status_code == 200, plugin_queue.text
        plugin_queue_body = cast(dict[str, object], plugin_queue.json())
        plugin_items = cast(list[dict[str, object]], plugin_queue_body.get("items"))
        assert any(
            it.get("id") == plugin_id and it.get("version") == version for it in plugin_items
        )

        plugin_detail = client.get(
            f"/api/v1/admin/review/plugins/{plugin_id}/{version}", headers=op_headers
        )
        assert plugin_detail.status_code == 200, plugin_detail.text
        plugin_detail_body = cast(dict[str, object], plugin_detail.json())
        assert plugin_detail_body.get("id") == plugin_id
        assert plugin_detail_body.get("version") == version
        assert plugin_detail_body.get("code") == code

        plugin_note_op = client.post(
            f"/api/v1/admin/review/plugins/{plugin_id}/{version}:note",
            headers=op_headers,
            json={"note": "hi"},
        )
        assert plugin_note_op.status_code == 403, plugin_note_op.text

        reject_note = "rejected: policy"
        plugin_reject = client.post(
            f"/api/v1/admin/review/plugins/{plugin_id}/{version}:reject",
            headers=super_headers,
            json={"note": reject_note},
        )
        assert plugin_reject.status_code == 200, plugin_reject.text
        reject_body = cast(dict[str, object], plugin_reject.json())
        assert reject_body.get("id") == plugin_id
        assert reject_body.get("version") == version
        assert reject_body.get("status") == "rejected"

    with SessionLocal() as db:
        asset = db.get(UgcAsset, asset_id)
        assert asset is not None
        assert asset.status == "approved"
        assert asset.reviewed_at is not None
        assert asset.reviewed_by == super_admin.id
        assert asset.review_note == note_text.strip()

        approve_logs = list(
            db.execute(
                select(AuditLog).where(
                    AuditLog.action == "ugc_asset.approve",
                    AuditLog.target_type == "ugc_asset",
                    AuditLog.target_id == asset.id,
                )
            )
            .scalars()
            .all()
        )
        assert len(approve_logs) >= 1
        assert any(l.actor == f"admin:{super_admin.id}" for l in approve_logs)
        assert all('"note"' not in l.metadata_json for l in approve_logs)

        note_logs = list(
            db.execute(
                select(AuditLog).where(
                    AuditLog.action == "ugc_asset.review_note",
                    AuditLog.target_type == "ugc_asset",
                    AuditLog.target_id == asset.id,
                )
            )
            .scalars()
            .all()
        )
        assert len(note_logs) >= 1
        meta = cast(dict[str, object], json.loads(note_logs[-1].metadata_json))
        from_status = meta.get("from")
        assert from_status == "pending" or isinstance(from_status, str)
        assert meta.get("to") == from_status
        note_meta = cast(dict[str, object], meta.get("note"))
        assert note_meta.get("len") == len(note_text.strip())
        assert note_meta.get("sha256") == _sha256_hex(note_text.strip())

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
        assert pkg.status == "rejected"
        assert pkg.reviewed_at is not None
        assert pkg.reviewed_by == super_admin.id
        assert pkg.review_note == reject_note

        reject_logs = list(
            db.execute(
                select(AuditLog).where(
                    AuditLog.action == "plugin.reject",
                    AuditLog.target_type == "plugin_package",
                    AuditLog.target_id == pkg.id,
                )
            )
            .scalars()
            .all()
        )
        assert len(reject_logs) >= 1
        meta2 = cast(dict[str, object], json.loads(reject_logs[-1].metadata_json))
        assert "note" in meta2
        assert cast(dict[str, object], meta2["note"]).get("sha256") == _sha256_hex(reject_note)
