# pyright: reportMissingImports=false

from __future__ import annotations

import hashlib
import json
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.models import AdminKV, AdminUser, InviteCode, User
from app.db.session import SessionLocal
from app.main import app


def _random_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}@example.com"


def _bootstrap_register(client: TestClient, *, email: str, password: str) -> dict[str, str]:
    r = client.post("/api/v1/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    body = cast(dict[str, str], r.json())
    assert isinstance(body.get("access_token"), str) and body["access_token"]
    assert isinstance(body.get("refresh_token"), str) and body["refresh_token"]
    return body


def _admin_login(client: TestClient, *, email: str, password: str) -> dict[str, object]:
    r = client.post("/api/v1/admin/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    body = cast(dict[str, object], r.json())
    assert body.get("token_type") == "bearer"
    assert isinstance(body.get("access_token"), str) and body["access_token"]
    return body


def _set_feature_flags(
    *,
    invite_registration_enabled: bool | None = None,
    open_registration_enabled: bool | None = None,
) -> None:
    obj: dict[str, object] = {}
    if invite_registration_enabled is not None:
        obj["invite_registration_enabled"] = bool(invite_registration_enabled)
    if open_registration_enabled is not None:
        obj["open_registration_enabled"] = bool(open_registration_enabled)

    with SessionLocal() as db:
        row = AdminKV(
            namespace="feature_flags",
            key="global",
            value_json=json.dumps(
                obj,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ),
        )
        db.add(row)
        db.commit()


def _set_invite_registration_enabled(*, enabled: bool) -> None:
    _set_feature_flags(invite_registration_enabled=enabled)


def _create_invite_code(*, raw_code: str, max_uses: int = 1) -> None:
    code_hash = hashlib.sha256(raw_code.encode("utf-8")).hexdigest()
    with SessionLocal() as db:
        db.add(
            InviteCode(
                code_hash=code_hash,
                code_prefix=raw_code[:6],
                max_uses=int(max_uses),
                uses_count=0,
                expires_at=None,
                revoked_at=None,
                created_by_admin_id=None,
            )
        )
        db.commit()


def test_task_2_0_bootstrap_creates_user_and_admin_user_and_admin_login_works() -> None:
    email = _random_email("boot")
    pw = "password123"

    with TestClient(app) as client:
        _ = _bootstrap_register(client, email=email, password=pw)
        admin_body = _admin_login(client, email=email, password=pw)
        assert admin_body.get("role") == "super_admin"

    with SessionLocal() as db:
        u = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        assert u is not None
        assert isinstance(u.username, str) and re.fullmatch(r"[a-z0-9_]{3,32}", u.username)
        a = db.execute(select(AdminUser).where(AdminUser.email == email)).scalar_one_or_none()
        assert a is not None
        assert a.role == "super_admin"
        assert a.is_active is True


def test_task_2_0_after_bootstrap_missing_invite_returns_invite_code_required() -> None:
    with TestClient(app) as client:
        _ = _bootstrap_register(client, email=_random_email("u"), password="password123")

        r = client.post(
            "/api/v1/auth/register",
            json={"email": _random_email("u"), "password": "password123"},
        )
        assert r.status_code == 403, r.text
        assert cast(dict[str, object], r.json()).get("detail") == "invite_code_required"


def test_task_2_0_invite_registration_disabled_returns_registration_closed() -> None:
    with TestClient(app) as client:
        _ = _bootstrap_register(client, email=_random_email("u"), password="password123")

    _set_invite_registration_enabled(enabled=False)
    code = "TESTINVITE0001"
    _create_invite_code(raw_code=code, max_uses=10)

    with TestClient(app) as client:
        r = client.post(
            "/api/v1/auth/register",
            json={"email": _random_email("u"), "password": "password123", "invite_code": code},
        )
        assert r.status_code == 403, r.text
        assert cast(dict[str, object], r.json()).get("detail") == "registration_closed"


def test_task_2_0_open_registration_allows_register_without_invite_after_bootstrap() -> None:
    with TestClient(app) as client:
        _ = _bootstrap_register(client, email=_random_email("u"), password="password123")

    _set_feature_flags(invite_registration_enabled=True, open_registration_enabled=True)

    with TestClient(app) as client:
        r = client.post(
            "/api/v1/auth/register",
            json={"email": _random_email("u"), "password": "password123"},
        )
        assert r.status_code == 201, r.text


def test_task_2_0_invite_registration_disabled_closes_registration_even_if_open_enabled() -> None:
    with TestClient(app) as client:
        _ = _bootstrap_register(client, email=_random_email("u"), password="password123")

    _set_feature_flags(invite_registration_enabled=False, open_registration_enabled=True)

    with TestClient(app) as client:
        r = client.post(
            "/api/v1/auth/register",
            json={"email": _random_email("u"), "password": "password123"},
        )
        assert r.status_code == 403, r.text
        assert cast(dict[str, object], r.json()).get("detail") == "registration_closed"


def test_task_2_0_username_taken_returns_username_taken() -> None:
    email1 = _random_email("u")
    pw = "password123"

    with TestClient(app) as client:
        _ = _bootstrap_register(client, email=email1, password=pw)

    _set_feature_flags(invite_registration_enabled=True, open_registration_enabled=True)

    with SessionLocal() as db:
        u1 = db.execute(select(User).where(User.email == email1)).scalar_one()
        assert isinstance(u1.username, str) and u1.username
        uname = u1.username

    with TestClient(app) as client:
        r = client.post(
            "/api/v1/auth/register",
            json={"email": _random_email("u"), "password": pw, "username": uname},
        )
        assert r.status_code == 409, r.text
        assert cast(dict[str, object], r.json()).get("detail") == "username_taken"


def test_task_2_0_concurrent_bootstrap_only_one_succeeds() -> None:
    barrier = Barrier(2)

    def _do_register(email: str) -> tuple[int, dict[str, object]]:
        _ = barrier.wait(timeout=10)
        with TestClient(app) as client:
            r = client.post(
                "/api/v1/auth/register",
                json={"email": email, "password": "password123"},
            )
            return r.status_code, cast(dict[str, object], r.json())

    emails = [_random_email("c1"), _random_email("c2")]
    with ThreadPoolExecutor(max_workers=2) as ex:
        results = list(ex.map(_do_register, emails))

    codes = [c for (c, _b) in results]
    assert sorted(codes) == [201, 403]

    fail_body = [b for (c, b) in results if c != 201][0]
    assert fail_body.get("detail") == "invite_code_required"

    with SessionLocal() as db:
        users = list(db.execute(select(User)).scalars().all())
        admins = list(
            db.execute(select(AdminUser).where(AdminUser.role == "super_admin")).scalars().all()
        )
        assert len(users) == 1
        assert len(admins) == 1
