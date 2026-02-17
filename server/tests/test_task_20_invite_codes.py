# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false
# pyright: reportAny=false
# pyright: reportUnknownArgumentType=false

from __future__ import annotations

import json
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.core.config import settings
from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminUser, AuditLog, InviteCode
from app.db.session import SessionLocal, engine
from app.main import app


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


def _random_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}@example.com"


def _create_admin(*, role: str, password: str) -> AdminUser:
    with SessionLocal() as db:
        admin = AdminUser(
            email=_random_email("admin"),
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
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("token_type") == "bearer"
    token = body.get("access_token")
    assert isinstance(token, str) and token
    return token


def _admin_create_invite(
    client: TestClient,
    *,
    headers: dict[str, str],
    max_uses: int = 1,
) -> tuple[str, str]:
    resp = client.post(
        "/api/v1/admin/invites",
        headers=headers,
        json={"max_uses": max_uses},
    )
    assert resp.status_code == 201
    data = resp.json()
    invite_id = data.get("id")
    code = data.get("code")
    assert isinstance(invite_id, str) and invite_id
    assert isinstance(code, str) and code
    return invite_id, code


def test_task_20_register_requires_invite_in_prod() -> None:
    prev_env = settings.env
    settings.env = "production"
    try:
        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/auth/register",
                json={"email": _random_email("user"), "password": "password123"},
            )
            assert resp.status_code == 403
            assert resp.json().get("detail") == "invite_code_required"
    finally:
        settings.env = prev_env


def test_task_20_invite_register_one_time_and_admin_audit() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    op_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)
    operator = _create_admin(role="operator", password=op_pw)

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}

        op_token = _admin_login(client, email=operator.email, password=op_pw)
        op_headers = {"Authorization": f"Bearer {op_token}"}

        forbidden = client.post(
            "/api/v1/admin/invites",
            headers=op_headers,
            json={"max_uses": 1},
        )
        assert forbidden.status_code == 403

        invite_id, code = _admin_create_invite(client, headers=super_headers, max_uses=1)

        prev_env = settings.env
        settings.env = "prod"
        try:
            r1 = client.post(
                "/api/v1/auth/register",
                json={
                    "email": _random_email("user"),
                    "password": "password123",
                    "invite_code": code,
                },
            )
            assert r1.status_code == 201

            r2 = client.post(
                "/api/v1/auth/register",
                json={
                    "email": _random_email("user"),
                    "password": "password123",
                    "invite_code": code,
                },
            )
            assert r2.status_code == 403
            assert r2.json().get("detail") == "invite_code_exhausted"
        finally:
            settings.env = prev_env

        lst = client.get(
            "/api/v1/admin/invites",
            headers=op_headers,
            params={"limit": 50, "offset": 0},
        )
        assert lst.status_code == 200
        body = lst.json()
        items = body.get("items")
        assert isinstance(items, list)
        assert any(isinstance(it, dict) and it.get("id") == invite_id for it in items)
        assert all(isinstance(it, dict) and ("code" not in it) for it in items)

        red = client.get(
            f"/api/v1/admin/invites/{invite_id}/redemptions",
            headers=super_headers,
            params={"limit": 50, "offset": 0},
        )
        assert red.status_code == 200
        red_items = red.json().get("items")
        assert isinstance(red_items, list)
        assert len(red_items) == 1
        assert isinstance(red_items[0], dict)
        assert red_items[0].get("invite_id") == invite_id
        assert isinstance(red_items[0].get("user_id"), str) and red_items[0].get("user_id")
        assert isinstance(red_items[0].get("user_email"), str) and red_items[0].get("user_email")

        rev = client.post(
            f"/api/v1/admin/invites/{invite_id}:revoke",
            headers=super_headers,
        )
        assert rev.status_code == 200
        assert rev.json().get("revoked_at") is not None

    with SessionLocal() as db:
        inv = db.get(InviteCode, invite_id)
        assert inv is not None
        assert inv.uses_count == 1
        assert inv.max_uses == 1
        assert inv.revoked_at is not None

        audit_rows = (
            db.execute(
                select(AuditLog)
                .where(AuditLog.target_type == "invite_code", AuditLog.target_id == invite_id)
                .order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
            )
            .scalars()
            .all()
        )
        actions = [r.action for r in audit_rows]
        assert "invite_code.create" in actions
        assert "invite_code.revoke" in actions

        for r in audit_rows:
            meta_obj = json.loads(r.metadata_json)
            assert isinstance(meta_obj, dict)
            assert "code" not in meta_obj
