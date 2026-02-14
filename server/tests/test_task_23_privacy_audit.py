# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import io
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select, text

from app.core.security import hash_password
from app.core.logging import RedactingFormatter
from app.core.audit import purge_old_audit_logs
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


def test_task_23_redaction_audit_and_retention(caplog: pytest.LogCaptureFixture) -> None:
    redaction_logger = logging.getLogger("test.task23.redaction")
    redaction_logger.setLevel(logging.INFO)
    redaction_logger.propagate = False

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(RedactingFormatter(fmt="%(message)s"))
    redaction_logger.handlers = [handler]

    fake_token = "Bearer FAKE_TOKEN_FOR_TEST_123"
    fake_data_url = "data:image/png;base64," + ("FAKEB64" * 40)
    redaction_logger.info(
        "Authorization: %s image_base64=%s access_token=%s refresh_token=%s data=%s CHAT_TOKEN=%s",
        fake_token,
        "FAKEB64PAYLOAD",
        "FAKE_ACCESS_TOKEN",
        "FAKE_REFRESH_TOKEN",
        fake_data_url,
        "KEEP_ME",
    )
    redaction_logger.info(
        '{"authorization":"Bearer FAKE_TOKEN_IN_JSON","access_token":"FAKE_A","refresh_token":"FAKE_R","CHAT_TOKEN":"KEEP_ME"}'
    )
    handler.flush()

    redacted_out = stream.getvalue()
    assert "[REDACTED]" in redacted_out or "[REDACTED_B64]" in redacted_out
    assert "Authorization" in redacted_out
    assert "FAKE_TOKEN_FOR_TEST" not in redacted_out
    assert "data:image/png;base64," in redacted_out
    assert "FAKEB64" not in redacted_out
    assert "FAKE_ACCESS_TOKEN" not in redacted_out
    assert "FAKE_REFRESH_TOKEN" not in redacted_out
    assert "CHAT_TOKEN=KEEP_ME" in redacted_out

    user_email = _random_email("user")
    user_pw = "password123"

    admin_pw = f"pw-{uuid.uuid4().hex}"
    admin = _create_admin(role="super_admin", password=admin_pw)

    caplog.set_level(logging.INFO)

    with TestClient(app) as client:
        tokens = _register(client, email=user_email, password=user_pw)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        me_resp = client.get("/api/v1/auth/me", headers=headers)
        assert me_resp.status_code == 200, me_resp.text
        me = cast(dict[str, object], me_resp.json())
        user_id = cast(str, me["user_id"])

        save_resp = client.post("/api/v1/saves", json={"name": "save-23"}, headers=headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        tiny_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII="
        ok_resp = client.post(
            "/api/v1/sensors/screenshot",
            json={
                "save_id": save_id,
                "image_base64": tiny_png_b64,
                "privacy_mode": "strict",
            },
            headers=headers,
        )
        assert ok_resp.status_code == 200, ok_resp.text

        assert "image_base64" not in caplog.text
        assert tiny_png_b64[:20] not in caplog.text

        admin_token = _admin_login(client, email=admin.email, password=admin_pw)
        admin_headers = {"Authorization": f"Bearer {admin_token}"}
        cur_resp = client.get("/api/v1/admin/config/feature_flags", headers=admin_headers)
        assert cur_resp.status_code == 200, cur_resp.text
        cur = cast(dict[str, object], cur_resp.json())
        cur_enabled = bool(cur.get("plugins_enabled"))

        if cur_enabled:
            off_resp = client.put(
                "/api/v1/admin/config/feature_flags",
                headers=admin_headers,
                json={"plugins_enabled": False},
            )
            assert off_resp.status_code == 200, off_resp.text

        put_resp = client.put(
            "/api/v1/admin/config/feature_flags",
            headers=admin_headers,
            json={"plugins_enabled": True},
        )
        assert put_resp.status_code == 200, put_resp.text

        old_log_id = None
        with SessionLocal() as db:
            screenshot_logs = list(
                db.execute(
                    select(AuditLog).where(
                        AuditLog.action == "vision.screenshot",
                        AuditLog.target_type == "save",
                        AuditLog.target_id == save_id,
                    )
                )
                .scalars()
                .all()
            )
            assert len(screenshot_logs) >= 1
            s_log = screenshot_logs[-1]
            assert s_log.actor == f"user:{user_id}"
            assert "image_base64" not in s_log.metadata_json
            assert tiny_png_b64[:20] not in s_log.metadata_json
            assert s_log.metadata_json == json.dumps(
                json.loads(s_log.metadata_json),
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            )
            meta = cast(dict[str, object], json.loads(s_log.metadata_json))
            assert set(meta.keys()) == {"bytes", "emit_ws_event", "height", "privacy_mode", "width"}

            flag_logs = list(
                db.execute(
                    select(AuditLog).where(
                        AuditLog.action == "feature_flags.update",
                        AuditLog.target_type == "feature_flags",
                        AuditLog.target_id == "global",
                    )
                )
                .scalars()
                .all()
            )
            assert len(flag_logs) >= 1
            on_logs: list[AuditLog] = []
            for row in flag_logs:
                try:
                    f_meta = cast(dict[str, object], json.loads(row.metadata_json))
                    assert set(f_meta.keys()) >= {
                        "namespace",
                        "key",
                        "changed_keys",
                        "prev",
                        "next",
                    }
                    assert '"plugins_enabled":' not in row.metadata_json
                    assert row.metadata_json == json.dumps(
                        json.loads(row.metadata_json),
                        ensure_ascii=True,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    changed_keys_obj = f_meta.get("changed_keys")
                    changed_keys = (
                        [k for k in changed_keys_obj if isinstance(k, str)]
                        if isinstance(changed_keys_obj, list)
                        else []
                    )
                    if (
                        f_meta.get("namespace") == "feature_flags"
                        and f_meta.get("key") == "global"
                        and "plugins_enabled" in changed_keys
                    ):
                        on_logs.append(row)
                except Exception:
                    continue
            assert len(on_logs) >= 1

            old_log = AuditLog(
                actor="admin:cleanup",
                action="test.old",
                target_type="test",
                target_id=uuid.uuid4().hex,
                metadata_json=json.dumps(
                    {}, ensure_ascii=True, separators=(",", ":"), sort_keys=True
                ),
                created_at=datetime.now(tz=timezone.utc).replace(tzinfo=None) - timedelta(days=400),
            )
            db.add(old_log)
            db.commit()
            old_log_id = old_log.id

        with SessionLocal() as db:
            cleanup_body = purge_old_audit_logs(
                db,
                now=datetime.now(tz=timezone.utc).replace(tzinfo=None),
                retention_days=1,
            )
        deleted_obj = cleanup_body.get("deleted")
        deleted = int(deleted_obj) if isinstance(deleted_obj, int) else 0
        assert deleted >= 1

        with SessionLocal() as db:
            assert old_log_id is not None
            gone = db.get(AuditLog, old_log_id)
            assert gone is None

            latest_logs = list(
                db.execute(select(AuditLog).order_by(AuditLog.created_at.desc())).scalars().all()
            )

    repo_root = Path(__file__).resolve().parents[2]
    evidence_path = repo_root / ".sisyphus" / "evidence" / "task-23-audit.txt"
    evidence_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    lines.append("Task 23 Evidence: privacy/safety baseline")
    lines.append("")
    lines.append("Operations:")
    lines.append("- POST /api/v1/sensors/screenshot (strict)")
    lines.append("- PUT /api/v1/admin/config/feature_flags (plugins_enabled -> true)")
    lines.append("- retention: purge_old_audit_logs(retention_days=1)")
    lines.append("")
    lines.append("Audit logs (latest 8):")

    for row in latest_logs[:8]:
        try:
            meta_obj = cast(dict[str, object], json.loads(row.metadata_json))
            keys = sorted([k for k in meta_obj.keys()])
        except Exception:
            keys = []
        lines.append(
            f"- action={row.action} target={row.target_type}:{row.target_id} created_at={row.created_at.isoformat()} meta_keys={keys}"
        )

    lines.append("")
    lines.append("Redaction sample:")
    lines.append(
        "- input contains: Authorization: Bearer ... + image_base64=... + data:image/...;base64,... + access_token/refresh_token"
    )
    lines.append(f"- output: {redacted_out.strip()}")
    lines.append("")
    lines.append("Sensitive assertions:")
    lines.append("- caplog: not contains 'image_base64' / screenshot base64 prefix")
    lines.append(
        "- audit metadata: only bytes/width/height/privacy_mode/emit_ws_event; no image_base64"
    )

    _ = evidence_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert evidence_path.exists()
