# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import io
import json
import uuid
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminUser, AuditLog
from app.db.session import engine, SessionLocal
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


def test_task_20_ugc_upload_approve_then_list_approved_writes_evidence() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        admin_pw = f"pw-{uuid.uuid4().hex}"
        admin = _create_admin(role="super_admin", password=admin_pw)
        admin_token = _admin_login(client, email=admin.email, password=admin_pw)
        admin_headers = {"Authorization": f"Bearer {admin_token}"}

        manifest_obj = {
            "name": "hello-ugc",
            "version": "0.0.1",
            "description": "task-20 ugc manifest",
        }
        manifest_json = json.dumps(manifest_obj, ensure_ascii=True)

        upload_resp = client.post(
            "/api/v1/ugc/assets",
            headers=headers,
            data={
                "asset_type": "test_asset",
                "manifest_json": manifest_json,
            },
            files={
                "file": (
                    "user-supplied-name.bin",
                    io.BytesIO(b"hello ugc"),
                    "application/octet-stream",
                )
            },
        )
        assert upload_resp.status_code == 201, upload_resp.text
        upload_body = cast(dict[str, object], upload_resp.json())
        asset_id = upload_body.get("id")
        assert isinstance(asset_id, str) and asset_id
        assert upload_body.get("status") == "pending"

        approve_resp = client.post(
            f"/api/v1/admin/review/ugc/{asset_id}:approve",
            headers=admin_headers,
        )
        assert approve_resp.status_code == 200, approve_resp.text
        approve_body = cast(dict[str, object], approve_resp.json())
        assert approve_body.get("asset_id") == asset_id
        assert approve_body.get("status") == "approved"

        list_resp = client.get("/api/v1/ugc/assets?status=approved", headers=headers)
        assert list_resp.status_code == 200, list_resp.text
        list_body = cast(list[dict[str, object]], list_resp.json())
        assert any(it.get("id") == asset_id and it.get("status") == "approved" for it in list_body)

        with SessionLocal() as db:
            logs = list(
                db.execute(
                    select(AuditLog).where(
                        AuditLog.target_type == "ugc_asset",
                        AuditLog.target_id == asset_id,
                        AuditLog.action == "ugc_asset.approve",
                    )
                )
                .scalars()
                .all()
            )
            assert len(logs) >= 1
            assert any(l.actor == f"admin:{admin.id}" for l in logs)

        repo_root = Path(__file__).resolve().parents[2]
        evidence_path = repo_root / ".sisyphus" / "evidence" / "task-20-ugc-approve.txt"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        evidence_lines = [
            "task-20 ugc approve evidence",
            f"asset_id={asset_id}",
            f"upload_status={upload_resp.status_code}",
            f"upload_body={upload_body}",
            f"approve_status={approve_resp.status_code}",
            f"approve_body={approve_body}",
            f"list_status={list_resp.status_code}",
            f"list_body={list_body}",
            "assert_client_list_contains_asset=True",
            "assert_audit_log_written=True",
            "",
        ]
        _ = evidence_path.write_text("\n".join(evidence_lines), encoding="utf-8")
