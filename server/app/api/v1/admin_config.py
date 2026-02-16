# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

import json
import hashlib
from datetime import datetime, timezone
from typing import cast

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.admin_deps import get_current_admin_user, require_super_admin
from app.core.audit import purge_old_audit_logs
from app.core.config import settings
from app.db.models import AdminKV, AdminUser, AuditLog
from app.db.session import get_db


router = APIRouter(prefix="/admin/config", tags=["admin"])


def _to_naive_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _canonical_json(obj: dict[str, object]) -> str:
    try:
        return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Body contains non-JSON-serializable values",
        )


def _require_object(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Body must be a JSON object",
        )
    return cast(dict[str, object], payload)


def _sha256_hex(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _load_json_object(raw: str) -> dict[str, object]:
    try:
        val = cast(object, json.loads(raw))
    except Exception:
        return {}
    if isinstance(val, dict):
        return cast(dict[str, object], val)
    return {}


def _parse_metadata(raw: str) -> object | str:
    try:
        return cast(object, json.loads(raw))
    except Exception:
        return raw


class AuditLogListItem(BaseModel):
    id: str
    actor: str
    action: str
    target_type: str
    target_id: str
    metadata: object | str
    created_at: datetime


class AuditLogListResponse(BaseModel):
    items: list[AuditLogListItem] = Field(default_factory=list)
    next_offset: int | None = None


def _get_kv(db: Session, *, namespace: str, key: str) -> AdminKV | None:
    stmt = select(AdminKV).where(AdminKV.namespace == namespace, AdminKV.key == key)
    return db.execute(stmt).scalar_one_or_none()


def _upsert_kv(
    db: Session, *, namespace: str, key: str, value_obj: dict[str, object]
) -> dict[str, object]:
    now = datetime.utcnow()
    existing = _get_kv(db, namespace=namespace, key=key)
    raw = _canonical_json(value_obj)
    if existing is None:
        existing = AdminKV(namespace=namespace, key=key, value_json=raw, updated_at=now)
        db.add(existing)
    else:
        existing.value_json = raw
        existing.updated_at = now
    db.commit()
    return _load_json_object(existing.value_json)


@router.get(
    "/models",
    operation_id="admin_config_get_models",
)
async def admin_get_models(
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    row = _get_kv(db, namespace="config", key="models")
    if row is None:
        return {}
    return _load_json_object(row.value_json)


@router.put(
    "/models",
    operation_id="admin_config_put_models",
)
async def admin_put_models(
    payload: object = Body(...),
    _admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    obj = _require_object(payload)
    return _upsert_kv(db, namespace="config", key="models", value_obj=obj)


@router.get(
    "/prompts",
    operation_id="admin_config_get_prompts",
)
async def admin_get_prompts(
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    row = _get_kv(db, namespace="config", key="prompts")
    if row is None:
        return {}
    return _load_json_object(row.value_json)


@router.put(
    "/prompts",
    operation_id="admin_config_put_prompts",
)
async def admin_put_prompts(
    payload: object = Body(...),
    _admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    obj = _require_object(payload)
    return _upsert_kv(db, namespace="config", key="prompts", value_obj=obj)


def _default_feature_flags() -> dict[str, object]:
    return {"plugins_enabled": False}


@router.get(
    "/feature_flags",
    operation_id="admin_config_get_feature_flags",
)
async def admin_get_feature_flags(
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    row = _get_kv(db, namespace="feature_flags", key="global")
    if row is None:
        return _default_feature_flags()
    loaded = _load_json_object(row.value_json)
    merged = _default_feature_flags()
    merged.update(loaded)
    return merged


@router.put(
    "/feature_flags",
    operation_id="admin_config_put_feature_flags",
)
async def admin_put_feature_flags(
    payload: object = Body(...),
    admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    obj = _require_object(payload)
    if "plugins_enabled" not in obj or not isinstance(obj.get("plugins_enabled"), bool):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="plugins_enabled must be a boolean",
        )

    prev_row = _get_kv(db, namespace="feature_flags", key="global")
    prev_loaded = _load_json_object(prev_row.value_json) if prev_row is not None else {}
    prev_merged = _default_feature_flags()
    prev_merged.update(prev_loaded)

    stored = _upsert_kv(db, namespace="feature_flags", key="global", value_obj=obj)
    merged = _default_feature_flags()
    merged.update(stored)

    changed_keys = sorted(
        [
            k
            for k in set(prev_merged.keys()) | set(merged.keys())
            if prev_merged.get(k) != merged.get(k)
        ]
    )

    if changed_keys:
        now = datetime.utcnow()

        prev_raw = _canonical_json(prev_merged)
        next_raw = _canonical_json(merged)
        db.add(
            AuditLog(
                actor=f"admin:{admin.id}",
                action="feature_flags.update",
                target_type="feature_flags",
                target_id="global",
                metadata_json=_canonical_json(
                    {
                        "namespace": "feature_flags",
                        "key": "global",
                        "changed_keys": changed_keys,
                        "prev": {"sha256": _sha256_hex(prev_raw), "len": len(prev_raw)},
                        "next": {"sha256": _sha256_hex(next_raw), "len": len(next_raw)},
                    }
                ),
                created_at=now,
            )
        )
        db.commit()

    return merged


@router.post(
    "/audit_logs:cleanup",
    operation_id="admin_audit_logs_cleanup",
)
async def admin_audit_logs_cleanup(
    days: int | None = Query(None, ge=1, le=3650),
    _admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    retention_days = int(days) if days is not None else int(settings.audit_log_retention_days)
    now = datetime.utcnow()
    return purge_old_audit_logs(db, now=now, retention_days=retention_days)


@router.get(
    "/audit_logs",
    operation_id="admin_audit_logs_list",
    response_model=AuditLogListResponse,
)
async def admin_audit_logs_list(
    actor: str | None = Query(None, min_length=1, max_length=50),
    action: str | None = Query(None, min_length=1, max_length=100),
    target_type: str | None = Query(None, min_length=1, max_length=50),
    target_id: str | None = Query(None, min_length=1, max_length=64),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> AuditLogListResponse:
    stmt = select(AuditLog)

    if actor is not None:
        stmt = stmt.where(AuditLog.actor == actor)
    if action is not None:
        stmt = stmt.where(AuditLog.action == action)
    if target_type is not None:
        stmt = stmt.where(AuditLog.target_type == target_type)
    if target_id is not None:
        stmt = stmt.where(AuditLog.target_id == target_id)

    if since is not None:
        stmt = stmt.where(AuditLog.created_at >= _to_naive_utc(since))
    if until is not None:
        stmt = stmt.where(AuditLog.created_at <= _to_naive_utc(until))

    stmt = (
        stmt.order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset(offset)
        .limit(limit + 1)
    )

    rows = list(db.execute(stmt).scalars().all())
    more = len(rows) > limit
    page = rows[:limit]

    items = [
        AuditLogListItem(
            id=row.id,
            actor=row.actor,
            action=row.action,
            target_type=row.target_type,
            target_id=row.target_id,
            metadata=_parse_metadata(row.metadata_json),
            created_at=row.created_at,
        )
        for row in page
    ]
    next_offset = (offset + len(page)) if more else None
    return AuditLogListResponse(items=items, next_offset=next_offset)
