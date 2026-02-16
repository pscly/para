# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

import json
import time
from datetime import datetime
from typing import cast
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.admin_deps import get_current_admin_user, require_super_admin
from app.core.admin_secrets import decrypt_secret, encrypt_secret, mask_encrypted_secret
from app.core.config import settings
from app.db.models import AdminKV, AdminLLMChannel, AdminUser, AuditLog
from app.db.session import get_db


router = APIRouter(prefix="/admin/llm", tags=["admin"])


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


def _normalize_openai_base_url(raw: str) -> str:
    u = raw.strip()
    if u == "":
        raise ValueError("base_url cannot be empty")
    p = urlparse(u)
    if not p.scheme or not p.netloc:
        raise ValueError("base_url must be a full URL")
    u = u.rstrip("/")
    if not u.endswith("/v1"):
        u = u + "/v1"
    return u


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
    return _require_object(cast(object, json.loads(existing.value_json)))


def _audit(
    db: Session,
    *,
    admin: AdminUser,
    action: str,
    target_type: str,
    target_id: str,
    metadata: dict[str, object] | None = None,
) -> None:
    meta = metadata or {}
    db.add(
        AuditLog(
            actor=f"admin:{admin.id}",
            action=action,
            target_type=target_type,
            target_id=target_id,
            metadata_json=_canonical_json(meta),
            created_at=datetime.utcnow(),
        )
    )


class LLMChannelBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    base_url: str = Field(..., min_length=1, max_length=2000)
    enabled: bool = True
    purpose: str = Field("chat", pattern="^(chat|embedding)$")
    default_model: str = Field("", max_length=100)
    timeout_ms: int = Field(60000, ge=1, le=300000)
    weight: int = Field(100, ge=0, le=1000000)


class LLMChannelCreate(LLMChannelBase):
    api_key: str = Field(..., min_length=1, max_length=5000)


class LLMChannelUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    base_url: str | None = Field(None, min_length=1, max_length=2000)
    enabled: bool | None = None
    purpose: str | None = Field(None, pattern="^(chat|embedding)$")
    default_model: str | None = Field(None, max_length=100)
    timeout_ms: int | None = Field(None, ge=1, le=300000)
    weight: int | None = Field(None, ge=0, le=1000000)
    api_key: str | None = Field(None, max_length=5000)


class LLMChannelOut(BaseModel):
    id: str
    name: str
    base_url: str
    enabled: bool
    purpose: str
    default_model: str
    timeout_ms: int
    weight: int

    api_key_present: bool
    api_key_masked: str | None

    created_at: datetime
    updated_at: datetime


class LLMChannelListResponse(BaseModel):
    items: list[LLMChannelOut] = Field(default_factory=list)


def _to_channel_out(row: AdminLLMChannel) -> LLMChannelOut:
    enc = row.api_key_enc
    return LLMChannelOut(
        id=row.id,
        name=row.name,
        base_url=row.base_url,
        enabled=row.enabled,
        purpose=row.purpose,
        default_model=row.default_model,
        timeout_ms=row.timeout_ms,
        weight=row.weight,
        api_key_present=bool(enc),
        api_key_masked=mask_encrypted_secret(enc),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get(
    "/channels",
    operation_id="admin_llm_channels_list",
    response_model=LLMChannelListResponse,
)
async def admin_llm_channels_list(
    purpose: str | None = Query(None, pattern="^(chat|embedding)$"),
    enabled: bool | None = Query(None),
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> LLMChannelListResponse:
    stmt = select(AdminLLMChannel)
    if purpose is not None:
        stmt = stmt.where(AdminLLMChannel.purpose == purpose)
    if enabled is not None:
        stmt = stmt.where(AdminLLMChannel.enabled == enabled)
    stmt = stmt.order_by(AdminLLMChannel.created_at.desc(), AdminLLMChannel.id.desc())
    rows = db.execute(stmt).scalars().all()
    return LLMChannelListResponse(items=[_to_channel_out(r) for r in rows])


@router.post(
    "/channels",
    operation_id="admin_llm_channels_create",
    response_model=LLMChannelOut,
    status_code=status.HTTP_201_CREATED,
)
async def admin_llm_channels_create(
    payload: LLMChannelCreate,
    admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> LLMChannelOut:
    exists = db.execute(
        select(AdminLLMChannel).where(AdminLLMChannel.name == payload.name)
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Channel name already exists"
        )

    now = datetime.utcnow()
    try:
        base_url = _normalize_openai_base_url(payload.base_url)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="base_url_invalid",
        )

    key_bytes = settings.admin_secrets_master_key_bytes
    api_key_enc = encrypt_secret(payload.api_key, key=key_bytes)

    row = AdminLLMChannel(
        name=payload.name,
        base_url=base_url,
        api_key_enc=api_key_enc,
        enabled=payload.enabled,
        purpose=payload.purpose,
        default_model=payload.default_model,
        timeout_ms=payload.timeout_ms,
        weight=payload.weight,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    _audit(
        db,
        admin=admin,
        action="llm_channel.create",
        target_type="llm_channel",
        target_id=row.id,
        metadata={
            "name": payload.name,
            "purpose": payload.purpose,
            "enabled": payload.enabled,
            "has_api_key": True,
        },
    )
    db.commit()
    db.refresh(row)
    return _to_channel_out(row)


@router.get(
    "/channels/{channel_id}",
    operation_id="admin_llm_channels_get",
    response_model=LLMChannelOut,
)
async def admin_llm_channels_get(
    channel_id: str,
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> LLMChannelOut:
    row = db.get(AdminLLMChannel, channel_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")
    return _to_channel_out(row)


@router.patch(
    "/channels/{channel_id}",
    operation_id="admin_llm_channels_update",
    response_model=LLMChannelOut,
)
async def admin_llm_channels_update(
    channel_id: str,
    payload: LLMChannelUpdate,
    admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> LLMChannelOut:
    row = db.get(AdminLLMChannel, channel_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")

    changed: list[str] = []

    if payload.name is not None and payload.name != row.name:
        exists = db.execute(
            select(AdminLLMChannel).where(
                AdminLLMChannel.name == payload.name, AdminLLMChannel.id != row.id
            )
        ).scalar_one_or_none()
        if exists is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Channel name already exists"
            )
        row.name = payload.name
        changed.append("name")
    if payload.base_url is not None:
        try:
            next_base_url = _normalize_openai_base_url(payload.base_url)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="base_url_invalid",
            )
        if next_base_url != row.base_url:
            row.base_url = next_base_url
            changed.append("base_url")
    if payload.enabled is not None and payload.enabled != row.enabled:
        row.enabled = payload.enabled
        changed.append("enabled")
    if payload.purpose is not None and payload.purpose != row.purpose:
        row.purpose = payload.purpose
        changed.append("purpose")
    if payload.default_model is not None and payload.default_model != row.default_model:
        row.default_model = payload.default_model
        changed.append("default_model")
    if payload.timeout_ms is not None and payload.timeout_ms != row.timeout_ms:
        row.timeout_ms = payload.timeout_ms
        changed.append("timeout_ms")
    if payload.weight is not None and payload.weight != row.weight:
        row.weight = payload.weight
        changed.append("weight")

    if "api_key" in payload.model_fields_set:
        if payload.api_key is None or payload.api_key.strip() == "":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="api_key cannot be cleared via update",
            )
        row.api_key_enc = encrypt_secret(
            payload.api_key, key=settings.admin_secrets_master_key_bytes
        )
        changed.append("api_key")

    if not changed:
        return _to_channel_out(row)

    row.updated_at = datetime.utcnow()
    _audit(
        db,
        admin=admin,
        action="llm_channel.update",
        target_type="llm_channel",
        target_id=row.id,
        metadata={"changed": changed},
    )
    db.commit()
    db.refresh(row)
    return _to_channel_out(row)


@router.delete(
    "/channels/{channel_id}",
    operation_id="admin_llm_channels_delete",
)
async def admin_llm_channels_delete(
    channel_id: str,
    admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    row = db.get(AdminLLMChannel, channel_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")
    db.delete(row)
    _audit(
        db,
        admin=admin,
        action="llm_channel.delete",
        target_type="llm_channel",
        target_id=channel_id,
        metadata={"name": row.name},
    )
    db.commit()
    return {"ok": True}


class LLMConnectivityTestResponse(BaseModel):
    ok: bool
    latency_ms: int | None = None
    detail: str | None = None


@router.post(
    "/channels/{channel_id}:test",
    operation_id="admin_llm_channels_test",
    response_model=LLMConnectivityTestResponse,
)
async def admin_llm_channels_test(
    channel_id: str,
    admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> LLMConnectivityTestResponse:
    row = db.get(AdminLLMChannel, channel_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")
    if not row.api_key_enc:
        return LLMConnectivityTestResponse(ok=False, detail="api_key_not_set")

    key_bytes = settings.admin_secrets_master_key_bytes
    try:
        api_key = decrypt_secret(row.api_key_enc, key=key_bytes)
    except Exception:
        return LLMConnectivityTestResponse(ok=False, detail="api_key_decrypt_failed")

    try:
        base_url = _normalize_openai_base_url(row.base_url)
    except ValueError:
        out = LLMConnectivityTestResponse(ok=False, detail="base_url_invalid")
        _audit(
            db,
            admin=admin,
            action="llm_channel.test",
            target_type="llm_channel",
            target_id=row.id,
            metadata={
                "ok": out.ok,
                "latency_ms": out.latency_ms,
                "detail": out.detail,
            },
        )
        db.commit()
        return out

    timeout_s = max(0.1, float(row.timeout_ms) / 1000.0)
    timeout = httpx.Timeout(timeout_s, connect=min(10.0, timeout_s))

    start = time.monotonic()
    try:
        async with httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            trust_env=False,
            headers={"Authorization": f"Bearer {api_key}"},
        ) as client:
            resp = await client.get("models")
        latency_ms = int((time.monotonic() - start) * 1000)
        if resp.status_code >= 400:
            out = LLMConnectivityTestResponse(
                ok=False,
                latency_ms=latency_ms,
                detail=f"http_{resp.status_code}",
            )
        else:
            out = LLMConnectivityTestResponse(ok=True, latency_ms=latency_ms, detail="ok")
    except Exception:
        latency_ms = int((time.monotonic() - start) * 1000)
        out = LLMConnectivityTestResponse(ok=False, latency_ms=latency_ms, detail="request_failed")

    _audit(
        db,
        admin=admin,
        action="llm_channel.test",
        target_type="llm_channel",
        target_id=row.id,
        metadata={
            "ok": out.ok,
            "latency_ms": out.latency_ms,
            "detail": out.detail,
        },
    )
    db.commit()
    return out


class LLMRoutingGlobal(BaseModel):
    default_chat_channel_id: str | None = Field(None, min_length=1, max_length=36)
    default_embedding_channel_id: str | None = Field(None, min_length=1, max_length=36)


@router.get(
    "/routing",
    operation_id="admin_llm_routing_get",
    response_model=LLMRoutingGlobal,
)
async def admin_llm_routing_get(
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> LLMRoutingGlobal:
    row = _get_kv(db, namespace="llm_routing", key="global")
    if row is None:
        return LLMRoutingGlobal(default_chat_channel_id=None, default_embedding_channel_id=None)
    try:
        val = cast(object, json.loads(row.value_json))
    except Exception:
        return LLMRoutingGlobal(default_chat_channel_id=None, default_embedding_channel_id=None)
    if not isinstance(val, dict):
        return LLMRoutingGlobal(default_chat_channel_id=None, default_embedding_channel_id=None)
    raw = cast(dict[object, object], val)
    return LLMRoutingGlobal(
        default_chat_channel_id=cast(str | None, raw.get("default_chat_channel_id")),
        default_embedding_channel_id=cast(str | None, raw.get("default_embedding_channel_id")),
    )


@router.put(
    "/routing",
    operation_id="admin_llm_routing_put",
    response_model=LLMRoutingGlobal,
)
async def admin_llm_routing_put(
    payload: LLMRoutingGlobal,
    admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> LLMRoutingGlobal:
    prev = await admin_llm_routing_get(_admin=admin, db=db)
    obj: dict[str, object] = {
        "default_chat_channel_id": payload.default_chat_channel_id,
        "default_embedding_channel_id": payload.default_embedding_channel_id,
    }
    next_raw = _upsert_kv(db, namespace="llm_routing", key="global", value_obj=obj)
    next_val = LLMRoutingGlobal(
        default_chat_channel_id=cast(str | None, next_raw.get("default_chat_channel_id")),
        default_embedding_channel_id=cast(str | None, next_raw.get("default_embedding_channel_id")),
    )
    _audit(
        db,
        admin=admin,
        action="llm_routing.update",
        target_type="llm_routing",
        target_id="global",
        metadata={"prev": prev.model_dump(), "next": next_val.model_dump()},
    )
    db.commit()
    return next_val
