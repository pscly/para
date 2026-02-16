# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.security import hash_password
from app.db.base import Base
from app.db.models import AdminUser
from app.db.session import SessionLocal, engine
from app.main import app


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


TokenPair = dict[str, str]


def _random_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}@example.com"


def _register(client: TestClient, *, email: str, password: str) -> TokenPair:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 201, resp.text
    body = cast(TokenPair, resp.json())
    assert "access_token" in body and "refresh_token" in body
    return body


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
    body = cast(dict[str, object], resp.json())
    assert body.get("token_type") == "bearer"
    token = body.get("access_token")
    assert isinstance(token, str) and token != ""
    return token


def _iso_to_dt(s: str) -> datetime:
    return datetime.fromisoformat(s)


def test_task_3_5_audit_logs_list_filters_and_pagination() -> None:
    user_email = _random_email("user")
    user_pw = "password123"

    super_pw = f"pw-{uuid.uuid4().hex}"
    op_pw = f"pw-{uuid.uuid4().hex}"
    super_admin = _create_admin(role="super_admin", password=super_pw)
    operator = _create_admin(role="operator", password=op_pw)

    started = datetime.now(tz=timezone.utc)

    with TestClient(app) as client:
        tokens = _register(client, email=user_email, password=user_pw)
        access = tokens["access_token"]
        user_headers = {"Authorization": f"Bearer {access}"}

        me_resp = client.get("/api/v1/auth/me", headers=user_headers)
        assert me_resp.status_code == 200, me_resp.text
        me = cast(dict[str, object], me_resp.json())
        user_id = cast(str, me["user_id"])

        save_resp = client.post("/api/v1/saves", json={"name": "save-3-5"}, headers=user_headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        tiny_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII="
        shot_resp = client.post(
            "/api/v1/sensors/screenshot",
            json={
                "save_id": save_id,
                "image_base64": tiny_png_b64,
                "privacy_mode": "strict",
            },
            headers=user_headers,
        )
        assert shot_resp.status_code == 200, shot_resp.text

        super_token = _admin_login(client, email=super_admin.email, password=super_pw)
        op_token = _admin_login(client, email=operator.email, password=op_pw)
        super_headers = {"Authorization": f"Bearer {super_token}"}
        op_headers = {"Authorization": f"Bearer {op_token}"}

        flags_resp = client.get("/api/v1/admin/config/feature_flags", headers=super_headers)
        assert flags_resp.status_code == 200, flags_resp.text
        cur_flags = cast(dict[str, object], flags_resp.json())
        cur_enabled = bool(cur_flags.get("plugins_enabled"))

        flip_resp = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=super_headers,
            json={"plugins_enabled": (not cur_enabled)},
        )
        assert flip_resp.status_code == 200, flip_resp.text

        manifest_json = '{"name":"hello-ugc","version":"0.0.1","description":"task-3-5 ugc"}'
        upload_resp = client.post(
            "/api/v1/ugc/assets",
            headers=user_headers,
            data={"asset_type": "test_asset", "manifest_json": manifest_json},
            files={
                "file": (
                    "asset.bin",
                    io.BytesIO(b"hello ugc"),
                    "application/octet-stream",
                )
            },
        )
        assert upload_resp.status_code == 201, upload_resp.text
        asset_id = cast(str, cast(dict[str, object], upload_resp.json())["id"])

        approve_resp = client.post(
            f"/api/v1/admin/review/ugc/{asset_id}:approve",
            headers=super_headers,
        )
        assert approve_resp.status_code == 200, approve_resp.text

        list_resp = client.get(
            "/api/v1/admin/config/audit_logs",
            params={"limit": 20, "offset": 0, "since": started.isoformat()},
            headers=op_headers,
        )
        assert list_resp.status_code == 200, list_resp.text
        list_body = cast(dict[str, object], list_resp.json())
        items = cast(list[dict[str, object]], list_body.get("items"))
        assert isinstance(items, list)
        assert any(it.get("action") == "vision.screenshot" for it in items)
        assert any(it.get("action") == "feature_flags.update" for it in items)
        assert any(it.get("action") == "ugc_asset.approve" for it in items)

        list_resp_again = client.get(
            "/api/v1/admin/config/audit_logs",
            params={"limit": 20, "offset": 0, "since": started.isoformat()},
            headers=op_headers,
        )
        assert list_resp_again.status_code == 200, list_resp_again.text
        ids_1 = [cast(str, it["id"]) for it in items]
        ids_2 = [
            cast(str, it["id"])
            for it in cast(list[dict[str, object]], list_resp_again.json()["items"])
        ]
        assert ids_1 == ids_2

        created = [
            (_iso_to_dt(cast(str, it["created_at"])), cast(str, it["id"]))
            for it in items
            if "created_at" in it and "id" in it
        ]
        assert created == sorted(created, key=lambda x: (x[0], x[1]), reverse=True)

        shot_list = client.get(
            "/api/v1/admin/config/audit_logs",
            params={
                "action": "vision.screenshot",
                "target_type": "save",
                "target_id": save_id,
                "limit": 10,
                "offset": 0,
            },
            headers=op_headers,
        )
        assert shot_list.status_code == 200, shot_list.text
        shot_items = cast(
            list[dict[str, object]], cast(dict[str, object], shot_list.json())["items"]
        )
        assert len(shot_items) >= 1
        assert all(it.get("action") == "vision.screenshot" for it in shot_items)
        assert any(it.get("actor") == f"user:{user_id}" for it in shot_items)
        assert isinstance(shot_items[0].get("metadata"), dict)

        flags_list = client.get(
            "/api/v1/admin/config/audit_logs",
            params={
                "action": "feature_flags.update",
                "actor": f"admin:{super_admin.id}",
                "target_type": "feature_flags",
                "target_id": "global",
                "limit": 10,
                "offset": 0,
            },
            headers=op_headers,
        )
        assert flags_list.status_code == 200, flags_list.text
        flags_items = cast(
            list[dict[str, object]], cast(dict[str, object], flags_list.json())["items"]
        )
        assert len(flags_items) >= 1
        assert all(it.get("action") == "feature_flags.update" for it in flags_items)
        assert all(it.get("actor") == f"admin:{super_admin.id}" for it in flags_items)
        assert isinstance(flags_items[0].get("metadata"), dict)

        ugc_list = client.get(
            "/api/v1/admin/config/audit_logs",
            params={
                "action": "ugc_asset.approve",
                "target_type": "ugc_asset",
                "target_id": asset_id,
                "limit": 10,
                "offset": 0,
            },
            headers=op_headers,
        )
        assert ugc_list.status_code == 200, ugc_list.text
        ugc_items = cast(list[dict[str, object]], cast(dict[str, object], ugc_list.json())["items"])
        assert len(ugc_items) >= 1
        assert any(it.get("target_id") == asset_id for it in ugc_items)
        assert isinstance(ugc_items[0].get("metadata"), dict)

        page1 = client.get(
            "/api/v1/admin/config/audit_logs",
            params={"limit": 2, "offset": 0, "since": started.isoformat()},
            headers=op_headers,
        )
        assert page1.status_code == 200, page1.text
        p1_body = cast(dict[str, object], page1.json())
        p1_items = cast(list[dict[str, object]], p1_body["items"])
        assert len(p1_items) <= 2
        next_offset = p1_body.get("next_offset")
        assert next_offset is None or isinstance(next_offset, int)

        if isinstance(next_offset, int):
            page2 = client.get(
                "/api/v1/admin/config/audit_logs",
                params={"limit": 2, "offset": next_offset, "since": started.isoformat()},
                headers=op_headers,
            )
            assert page2.status_code == 200, page2.text
            p2_body = cast(dict[str, object], page2.json())
            p2_items = cast(list[dict[str, object]], p2_body["items"])
            ids_p1 = {cast(str, it["id"]) for it in p1_items}
            ids_p2 = {cast(str, it["id"]) for it in p2_items}
            assert ids_p1.isdisjoint(ids_p2)
