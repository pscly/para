# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import json
import uuid
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminUser, AuditLog
from app.db.session import SessionLocal, engine
from app.main import app


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


TokenPair = dict[str, str]


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
    assert resp.status_code == 200, resp.text
    data = cast(dict[str, object], resp.json())
    assert data.get("token_type") == "bearer"
    token = data.get("access_token")
    assert isinstance(token, str) and token != ""
    return token


def _register_user(client: TestClient, *, email: str, password: str) -> TokenPair:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 201, resp.text
    data = cast(TokenPair, resp.json())
    assert "access_token" in data
    assert "refresh_token" in data
    return data


def test_admin_debug_allowed_operator_forbidden_403() -> None:
    op_pw = f"pw-{uuid.uuid4().hex}"
    operator = _create_admin(role="operator", password=op_pw)

    with TestClient(app) as client:
        op_token = _admin_login(client, email=operator.email, password=op_pw)
        op_headers = {"Authorization": f"Bearer {op_token}"}

        get_resp = client.get(
            "/api/v1/admin/users/debug_allowed",
            headers=op_headers,
            params={"email": _random_email("u")},
        )
        assert get_resp.status_code == 403, get_resp.text

        put_resp = client.put(
            "/api/v1/admin/users/debug_allowed",
            headers=op_headers,
            json={"email": _random_email("u"), "debug_allowed": True},
        )
        assert put_resp.status_code == 403, put_resp.text


def test_admin_debug_allowed_super_admin_can_update_and_audited_and_reflected_in_me() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)

    user_email = _random_email("user")
    user_password = "password123"

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}

        tokens = _register_user(client, email=user_email, password=user_password)
        user_headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        me_before = client.get("/api/v1/auth/me", headers=user_headers)
        assert me_before.status_code == 200, me_before.text
        body_before = cast(dict[str, object], me_before.json())
        assert body_before.get("email") == user_email
        assert body_before.get("debug_allowed") is False
        user_id = cast(str, body_before["user_id"])
        assert user_id

        put_resp = client.put(
            "/api/v1/admin/users/debug_allowed",
            headers=super_headers,
            json={"email": user_email, "debug_allowed": True},
        )
        assert put_resp.status_code == 200, put_resp.text
        put_body = cast(dict[str, object], put_resp.json())
        assert put_body.get("email") == user_email
        assert put_body.get("debug_allowed") is True

        get_resp = client.get(
            "/api/v1/admin/users/debug_allowed",
            headers=super_headers,
            params={"email": user_email},
        )
        assert get_resp.status_code == 200, get_resp.text
        get_body = cast(dict[str, object], get_resp.json())
        assert get_body.get("email") == user_email
        assert get_body.get("debug_allowed") is True

        me_after = client.get("/api/v1/auth/me", headers=user_headers)
        assert me_after.status_code == 200, me_after.text
        body_after = cast(dict[str, object], me_after.json())
        assert body_after.get("debug_allowed") is True

    with SessionLocal() as db:
        logs = (
            db.execute(
                select(AuditLog)
                .where(
                    AuditLog.actor == f"admin:{super_admin.id}",
                    AuditLog.action == "user.debug_allowed.update",
                )
                .order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
            )
            .scalars()
            .all()
        )
        assert len(logs) == 1
        log = logs[0]
        assert log.target_type == "user"
        assert log.target_id == user_id

        meta = cast(dict[str, object], json.loads(log.metadata_json))
        assert set(meta.keys()) == {"email", "user_id", "prev", "next"}
        assert meta.get("email") == user_email
        assert meta.get("user_id") == user_id
        assert meta.get("prev") is False
        assert meta.get("next") is True
