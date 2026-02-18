# pyright: reportMissingImports=false

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import settings
from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminUser, AuthRateLimit
from app.db.session import SessionLocal, engine
from app.main import app
from app.services.auth_rate_limit import auth_rate_limit_key


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


def _random_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}@example.com"


def _admin_login(client: TestClient, *, email: str, password: str) -> str:
    resp = client.post(
        "/api/v1/admin/auth/login",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 200, resp.text
    body = cast(dict[str, object], resp.json())
    token = body.get("access_token")
    assert isinstance(token, str) and token
    return token


def _admin_create_invite(client: TestClient, *, token: str, max_uses: int = 10) -> str:
    resp = client.post(
        "/api/v1/admin/invites",
        headers={"Authorization": f"Bearer {token}"},
        json={"max_uses": max_uses},
    )
    assert resp.status_code == 201, resp.text
    body = cast(dict[str, object], resp.json())
    code = body.get("code")
    assert isinstance(code, str) and code
    return code


def _set_rate_limit(*, enabled: bool, max_failures: int, window_seconds: int):
    old = (
        settings.auth_rate_limit_enabled,
        settings.auth_rate_limit_max_failures,
        settings.auth_rate_limit_window_seconds,
    )
    settings.auth_rate_limit_enabled = enabled
    settings.auth_rate_limit_max_failures = max_failures
    settings.auth_rate_limit_window_seconds = window_seconds
    return old


def _restore_rate_limit(old: tuple[bool, int, int]) -> None:
    settings.auth_rate_limit_enabled = old[0]
    settings.auth_rate_limit_max_failures = old[1]
    settings.auth_rate_limit_window_seconds = old[2]


def _expire_key(key: str) -> None:
    with SessionLocal() as db:
        row = db.get(AuthRateLimit, key)
        assert row is not None
        row.reset_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=1)
        db.commit()


def _clear_key(key: str) -> None:
    with SessionLocal() as db:
        row = db.get(AuthRateLimit, key)
        if row is None:
            return
        db.delete(row)
        db.commit()


def test_task_3_1_login_rate_limit_lockout_expiry_and_success_resets() -> None:
    old = _set_rate_limit(enabled=True, max_failures=3, window_seconds=300)
    try:
        email = _random_email("user")
        pw = "password123"

        with TestClient(app) as client:
            reg = client.post("/api/v1/auth/register", json={"email": email, "password": pw})
            assert reg.status_code == 201, reg.text

            for _ in range(3):
                bad = client.post(
                    "/api/v1/auth/login",
                    json={"email": email, "password": "wrong-password"},
                )
                assert bad.status_code == 401, bad.text

            blocked = client.post(
                "/api/v1/auth/login",
                json={"email": email, "password": "wrong-password"},
            )
            assert blocked.status_code == 429, blocked.text

            blocked2 = client.post(
                "/api/v1/auth/login",
                json={"email": email, "password": pw},
            )
            assert blocked2.status_code == 429, blocked2.text

            key = auth_rate_limit_key(scope="auth_login", ip="testclient", identifier=email)
            _expire_key(key)

            ok = client.post(
                "/api/v1/auth/login",
                json={"email": email, "password": pw},
            )
            assert ok.status_code == 200, ok.text
            data = cast(dict[str, str], ok.json())
            assert isinstance(data.get("access_token"), str) and data["access_token"]
            assert isinstance(data.get("refresh_token"), str) and data["refresh_token"]

            with SessionLocal() as db:
                assert db.get(AuthRateLimit, key) is None

            after = client.post(
                "/api/v1/auth/login",
                json={"email": email, "password": "wrong-password"},
            )
            assert after.status_code == 401, after.text
    finally:
        _restore_rate_limit(old)


def test_task_3_1_admin_login_rate_limit_lockout_and_expiry() -> None:
    old = _set_rate_limit(enabled=True, max_failures=2, window_seconds=300)
    try:
        pw = f"pw-{uuid.uuid4().hex}"
        with SessionLocal() as db:
            admin = AdminUser(
                email=_random_email("admin"),
                password_hash=hash_password(pw),
                role="operator",
                is_active=True,
            )
            db.add(admin)
            db.commit()
            db.refresh(admin)

        with TestClient(app) as client:
            for _ in range(2):
                bad = client.post(
                    "/api/v1/admin/auth/login",
                    json={"email": admin.email, "password": "wrong-password"},
                )
                assert bad.status_code == 401, bad.text

            blocked = client.post(
                "/api/v1/admin/auth/login",
                json={"email": admin.email, "password": "wrong-password"},
            )
            assert blocked.status_code == 429, blocked.text

            key = auth_rate_limit_key(
                scope="admin_auth_login", ip="testclient", identifier=admin.email
            )
            _expire_key(key)

            ok = client.post(
                "/api/v1/admin/auth/login",
                json={"email": admin.email, "password": pw},
            )
            assert ok.status_code == 200, ok.text
    finally:
        _restore_rate_limit(old)


def test_task_3_1_refresh_rate_limit_lockout_and_success_resets() -> None:
    old = _set_rate_limit(enabled=True, max_failures=2, window_seconds=300)
    try:
        _clear_key(auth_rate_limit_key(scope="auth_refresh", ip="testclient", identifier=None))

        email = _random_email("user")
        pw = "password123"

        with TestClient(app) as client:
            reg = client.post("/api/v1/auth/register", json={"email": email, "password": pw})
            assert reg.status_code == 201, reg.text
            tokens = cast(dict[str, str], reg.json())
            refresh_token = tokens["refresh_token"]

            for _ in range(2):
                bad = client.post(
                    "/api/v1/auth/refresh",
                    json={"refresh_token": "invalid"},
                )
                assert bad.status_code == 401, bad.text

            blocked = client.post(
                "/api/v1/auth/refresh",
                json={"refresh_token": "invalid"},
            )
            assert blocked.status_code == 429, blocked.text

            key = auth_rate_limit_key(scope="auth_refresh", ip="testclient", identifier=None)
            _expire_key(key)

            ok = client.post(
                "/api/v1/auth/refresh",
                json={"refresh_token": refresh_token},
            )
            assert ok.status_code == 200, ok.text

            with SessionLocal() as db:
                assert db.get(AuthRateLimit, key) is None

            after = client.post(
                "/api/v1/auth/refresh",
                json={"refresh_token": "invalid"},
            )
            assert after.status_code == 401, after.text
    finally:
        _restore_rate_limit(old)


def test_task_3_1_register_rate_limit_applies() -> None:
    old = _set_rate_limit(enabled=True, max_failures=1, window_seconds=300)
    try:
        _clear_key(auth_rate_limit_key(scope="auth_register", ip="testclient", identifier=None))

        pw = "password123"
        with TestClient(app) as client:
            email1 = _random_email("user")
            ok = client.post("/api/v1/auth/register", json={"email": email1, "password": pw})
            assert ok.status_code == 201, ok.text

            dup = client.post("/api/v1/auth/register", json={"email": email1, "password": pw})
            assert dup.status_code == 409, dup.text

            blocked = client.post(
                "/api/v1/auth/register",
                json={"email": _random_email("user"), "password": pw},
            )
            assert blocked.status_code == 429, blocked.text

            key = auth_rate_limit_key(scope="auth_register", ip="testclient", identifier=None)
            _expire_key(key)

            admin_token = _admin_login(client, email=email1, password=pw)
            invite = _admin_create_invite(client, token=admin_token, max_uses=10)

            ok2 = client.post(
                "/api/v1/auth/register",
                json={"email": _random_email("user"), "password": pw, "invite_code": invite},
            )
            assert ok2.status_code == 201, ok2.text
    finally:
        _restore_rate_limit(old)
