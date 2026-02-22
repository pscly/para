# pyright: reportMissingImports=false

import uuid

from fastapi.testclient import TestClient
from typing import cast

from sqlalchemy import select, text

from app.db.base import Base
from app.db.models import User
from app.db.session import SessionLocal, engine
from app.main import app


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


def _refresh(client: TestClient, refresh_token: str) -> TokenPair:
    resp = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": refresh_token},
    )
    assert resp.status_code == 200, resp.text
    data = cast(TokenPair, resp.json())
    assert "access_token" in data
    assert "refresh_token" in data
    return data


def test_me_unauthenticated_returns_401() -> None:
    with TestClient(app) as client:
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 401, resp.text


def test_register_success_returns_tokens_and_me_works() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)

        me = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert me.status_code == 200, me.text
        body = cast(dict[str, object], me.json())
        assert body["email"] == email
        assert isinstance(body["user_id"], str)
        assert body["user_id"]
        assert body.get("debug_allowed") is False


def test_me_returns_debug_allowed_true_when_user_flag_set() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)

        with SessionLocal() as db:
            user = db.execute(select(User).where(User.email == email)).scalar_one()
            user.debug_allowed = True
            db.commit()

        me = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert me.status_code == 200, me.text
        body = cast(dict[str, object], me.json())
        assert body.get("debug_allowed") is True


def test_duplicate_register_returns_409() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        _ = _register(client, email=email, password=password)
        dup = client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": password},
        )
        assert dup.status_code == 409, dup.text


def test_login_wrong_password_returns_401() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        _ = _register(client, email=email, password=password)
        bad = client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "wrong-password"},
        )
        assert bad.status_code == 401, bad.text


def test_refresh_rotates_old_becomes_invalid_and_new_works() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens1 = _register(client, email=email, password=password)
        refresh1: str = tokens1["refresh_token"]

        tokens2 = _refresh(client, refresh_token=refresh1)
        refresh2: str = tokens2["refresh_token"]
        assert refresh2 != refresh1

        _ = _refresh(client, refresh_token=refresh2)

        old = client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": refresh1},
        )
        assert old.status_code == 401, old.text


def test_logout_revokes_refresh_token() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access: str = tokens["access_token"]
        refresh: str = tokens["refresh_token"]

        out = client.post(
            "/api/v1/auth/logout",
            headers={"Authorization": f"Bearer {access}"},
        )
        assert out.status_code == 204, out.text

        revoked = client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": refresh},
        )
        assert revoked.status_code == 401, revoked.text
