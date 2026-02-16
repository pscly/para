# pyright: reportMissingImports=false

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.core import security as core_security
from app.db.base import Base
from app.db.models import PasswordResetToken, User
from app.db.session import SessionLocal, engine
from app.main import app


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


def _random_email(prefix: str = "user") -> str:
    return f"{prefix}-{uuid.uuid4().hex}@example.com"


def test_task_3_2_weak_password_register_returns_400_not_422() -> None:
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/auth/register",
            json={"email": _random_email(), "password": "12345678"},
        )
        assert resp.status_code == 400, resp.text


def test_task_3_2_email_case_insensitive_duplicate_register_returns_409() -> None:
    base = f"user.case.{uuid.uuid4().hex}@example.com"
    email1 = base.upper()
    email2 = base.lower()
    pw = "password123"

    with TestClient(app) as client:
        ok = client.post(
            "/api/v1/auth/register",
            json={"email": email1, "password": pw},
        )
        assert ok.status_code == 201, ok.text

        dup = client.post(
            "/api/v1/auth/register",
            json={"email": email2, "password": pw},
        )
        assert dup.status_code == 409, dup.text


def test_task_3_2_login_email_case_insensitive() -> None:
    base = f"mixed.login.{uuid.uuid4().hex}@example.com"
    email = base.upper()
    pw = "password123"

    with TestClient(app) as client:
        ok = client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": pw},
        )
        assert ok.status_code == 201, ok.text

        login = client.post(
            "/api/v1/auth/login",
            json={"email": base.lower(), "password": pw},
        )
        assert login.status_code == 200, login.text
        body = cast(dict[str, str], login.json())
        assert isinstance(body.get("access_token"), str) and body["access_token"]


def test_task_3_2_password_reset_request_is_non_enumerating() -> None:
    email = _random_email()
    pw = "password123"

    with TestClient(app) as client:
        reg = client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": pw},
        )
        assert reg.status_code == 201, reg.text

        a = client.post("/api/v1/auth/password_reset/request", json={"email": email})
        b = client.post(
            "/api/v1/auth/password_reset/request",
            json={"email": _random_email("missing")},
        )
        assert a.status_code == 202, a.text
        assert b.status_code == 202, b.text
        assert a.json() == {"status": "accepted"}
        assert b.json() == {"status": "accepted"}


def test_task_3_2_password_reset_confirm_success_old_password_invalid_token_reuse_and_expiry() -> (
    None
):
    base = f"reset.user.{uuid.uuid4().hex}@example.com"
    email = base.upper()
    old_pw = "password123"
    new_pw = "newpass123"

    with TestClient(app) as client:
        reg = client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": old_pw},
        )
        assert reg.status_code == 201, reg.text

        def _fixed_token() -> str:
            return "fixed-reset-token"

        old = core_security.new_password_reset_token
        core_security.new_password_reset_token = _fixed_token
        try:
            req = client.post(
                "/api/v1/auth/password_reset/request",
                json={"email": email},
            )
            assert req.status_code == 202, req.text
            assert req.json() == {"status": "accepted"}
        finally:
            core_security.new_password_reset_token = old

        ok = client.post(
            "/api/v1/auth/password_reset/confirm",
            json={
                "email": base.lower(),
                "token": "fixed-reset-token",
                "new_password": new_pw,
            },
        )
        assert ok.status_code == 200, ok.text
        assert ok.json() == {"status": "ok"}

        bad_old = client.post(
            "/api/v1/auth/login",
            json={"email": base.upper(), "password": old_pw},
        )
        assert bad_old.status_code == 401, bad_old.text

        good_new = client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": new_pw},
        )
        assert good_new.status_code == 200, good_new.text

        reuse = client.post(
            "/api/v1/auth/password_reset/confirm",
            json={
                "email": email,
                "token": "fixed-reset-token",
                "new_password": "another123",
            },
        )
        assert reuse.status_code == 400, reuse.text

        def _expired_token() -> str:
            return "expired-reset-token"

        old2 = core_security.new_password_reset_token
        core_security.new_password_reset_token = _expired_token
        try:
            _ = client.post(
                "/api/v1/auth/password_reset/request",
                json={"email": email},
            )
        finally:
            core_security.new_password_reset_token = old2

        with SessionLocal() as db:
            user = db.execute(select(User).where(User.email == base.lower())).scalar_one()
            token_hash = core_security.hash_password_reset_token("expired-reset-token")
            row = (
                db.execute(
                    select(PasswordResetToken).where(
                        PasswordResetToken.user_id == user.id,
                        PasswordResetToken.token_hash == token_hash,
                    )
                )
                .scalars()
                .first()
            )
            assert row is not None
            row.expires_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=1)
            db.commit()

        expired = client.post(
            "/api/v1/auth/password_reset/confirm",
            json={
                "email": email,
                "token": "expired-reset-token",
                "new_password": "okpass123",
            },
        )
        assert expired.status_code == 400, expired.text
