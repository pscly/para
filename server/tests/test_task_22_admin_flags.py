# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import json
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from typing import cast

from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminKV, AdminUser, AuditLog
from app.db.session import SessionLocal, engine
from app.main import app


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


def _random_email() -> str:
    return f"admin-{uuid.uuid4().hex}@example.com"


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


def test_task_22_admin_flags_rbac_and_user_get() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    op_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)
    operator = _create_admin(role="operator", password=op_pw)

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}

        put_resp = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={
                "plugins_enabled": True,
                "invite_registration_enabled": True,
                "open_registration_enabled": False,
            },
        )
        assert put_resp.status_code == 200, put_resp.text
        put_data = cast(dict[str, object], put_resp.json())
        assert put_data.get("plugins_enabled") is True
        assert put_data.get("invite_registration_enabled") is True
        assert put_data.get("open_registration_enabled") is False

        ff_resp = client.get("/api/v1/feature_flags")
        assert ff_resp.status_code == 200, ff_resp.text
        ff = cast(dict[str, object], ff_resp.json())
        assert isinstance(ff.get("generated_at"), str) and ff.get("generated_at")
        flags = ff.get("feature_flags")
        assert isinstance(flags, dict)
        assert flags.get("plugins_enabled") is True
        assert flags.get("invite_registration_enabled") is True
        assert flags.get("open_registration_enabled") is False

        op_token = _admin_login(client, email=operator.email, password=op_pw)
        op_headers = {"Authorization": f"Bearer {op_token}"}

        get_admin_flags = client.get("/api/v1/admin/config/feature_flags", headers=op_headers)
        assert get_admin_flags.status_code == 200, get_admin_flags.text
        admin_flags = cast(dict[str, object], get_admin_flags.json())
        assert admin_flags.get("plugins_enabled") is True
        assert admin_flags.get("invite_registration_enabled") is True
        assert admin_flags.get("open_registration_enabled") is False

        op_put = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=op_headers,
            json={"plugins_enabled": False},
        )
        assert op_put.status_code == 403, op_put.text

    expected_raw = json.dumps(
        {"plugins_enabled": True},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    with SessionLocal() as db:
        row = db.execute(
            select(AdminKV).where(AdminKV.namespace == "feature_flags", AdminKV.key == "global")
        ).scalar_one_or_none()
        assert row is not None
        assert row.value_json == expected_raw


def test_task_22_admin_flags_put_requires_object_400() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}
        resp = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json="",
        )
        assert resp.status_code == 400, resp.text


def test_task_22_admin_flags_partial_update_does_not_clear_other_overrides() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}

        put1 = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={
                "plugins_enabled": True,
                "invite_registration_enabled": True,
                "open_registration_enabled": False,
            },
        )
        assert put1.status_code == 200, put1.text

        put2 = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={"invite_registration_enabled": False},
        )
        assert put2.status_code == 200, put2.text
        data2 = cast(dict[str, object], put2.json())
        assert data2.get("plugins_enabled") is True
        assert data2.get("invite_registration_enabled") is False
        assert data2.get("open_registration_enabled") is False

    expected_raw = json.dumps(
        {"invite_registration_enabled": False, "plugins_enabled": True},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    with SessionLocal() as db:
        row = db.execute(
            select(AdminKV).where(AdminKV.namespace == "feature_flags", AdminKV.key == "global")
        ).scalar_one_or_none()
        assert row is not None
        assert row.value_json == expected_raw


def test_task_22_admin_flags_open_registration_audit_changed_keys() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}

        reset = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={"open_registration_enabled": False},
        )
        assert reset.status_code == 200, reset.text

        put = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={"open_registration_enabled": True},
        )
        assert put.status_code == 200, put.text
        data = cast(dict[str, object], put.json())
        assert data.get("open_registration_enabled") is True

        restore = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={"open_registration_enabled": False},
        )
        assert restore.status_code == 200, restore.text

    with SessionLocal() as db:
        rows = list(
            db.execute(
                select(AuditLog).where(
                    AuditLog.actor == f"admin:{super_admin.id}",
                    AuditLog.action == "feature_flags.update",
                    AuditLog.target_type == "feature_flags",
                    AuditLog.target_id == "global",
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) >= 1

        saw = False
        for row in rows:
            try:
                meta = cast(dict[str, object], json.loads(row.metadata_json))
                ck = meta.get("changed_keys")
                changed_keys = [k for k in ck if isinstance(k, str)] if isinstance(ck, list) else []
                if "open_registration_enabled" in changed_keys:
                    saw = True
                    break
            except Exception:
                continue
        assert saw is True


def test_task_22_admin_flags_put_rejects_unknown_key_400() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}
        resp = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={"plugins_enabled": True, "nope": True},
        )
        assert resp.status_code == 400, resp.text
        data = cast(dict[str, object], resp.json())
        assert "Unknown feature flag" in str(data.get("detail"))


def test_task_22_admin_flags_put_rejects_non_bool_400() -> None:
    super_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)

    with TestClient(app) as client:
        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}
        resp = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={"invite_registration_enabled": "no"},
        )
        assert resp.status_code == 400, resp.text
        data = cast(dict[str, object], resp.json())
        assert data.get("detail") == "invite_registration_enabled must be a boolean"
