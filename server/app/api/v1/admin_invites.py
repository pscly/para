# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

import base64
import hashlib
import json
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.v1.admin_deps import get_current_admin_user, require_super_admin
from app.db.models import AdminUser, AuditLog, InviteCode, InviteRedemption
from app.db.session import get_db


router = APIRouter(prefix="/admin/invites", tags=["admin"])


def _canonical_json(obj: dict[str, object]) -> str:
    try:
        return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Body contains non-JSON-serializable values",
        )


def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _new_invite_code() -> str:
    raw = secrets.token_bytes(20)
    return base64.b32encode(raw).decode("ascii").rstrip("=")


class InviteCodeCreateRequest(BaseModel):
    max_uses: int = Field(1, ge=1, le=10_000)
    expires_at: datetime | None = None


class InviteCodeCreateResponse(BaseModel):
    id: str
    code: str
    code_prefix: str
    max_uses: int
    uses_count: int
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class InviteCodeListItem(BaseModel):
    id: str
    code_prefix: str
    max_uses: int
    uses_count: int
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class InviteCodeListResponse(BaseModel):
    items: list[InviteCodeListItem] = Field(default_factory=list)
    next_offset: int | None = None


class InviteRedemptionListItem(BaseModel):
    id: str
    invite_id: str
    user_id: str
    user_email: str
    used_at: datetime


class InviteRedemptionListResponse(BaseModel):
    items: list[InviteRedemptionListItem] = Field(default_factory=list)
    next_offset: int | None = None


@router.post(
    "",
    response_model=InviteCodeCreateResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="admin_invites_create",
)
async def admin_invites_create(
    payload: InviteCodeCreateRequest,
    admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> InviteCodeCreateResponse:
    now = datetime.utcnow()
    expires_at = payload.expires_at
    if expires_at is not None and expires_at.tzinfo is not None:
        expires_at = expires_at.astimezone(timezone.utc).replace(tzinfo=None)

    last_hash_prefix = ""
    for _ in range(5):
        code = _new_invite_code()
        code_hash = _sha256_hex(code)
        code_prefix = code[:6]
        last_hash_prefix = code_hash[:8]

        row = InviteCode(
            code_hash=code_hash,
            code_prefix=code_prefix,
            max_uses=int(payload.max_uses),
            uses_count=0,
            expires_at=expires_at,
            revoked_at=None,
            created_by_admin_id=admin.id,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            continue

        db.add(
            AuditLog(
                actor=f"admin:{admin.id}",
                action="invite_code.create",
                target_type="invite_code",
                target_id=row.id,
                metadata_json=_canonical_json(
                    {
                        "code_prefix": code_prefix,
                        "code_hash_prefix": last_hash_prefix,
                        "max_uses": int(payload.max_uses),
                        "expires_at": expires_at.isoformat() if expires_at is not None else None,
                    }
                ),
                created_at=now,
            )
        )
        db.commit()
        return InviteCodeCreateResponse(
            id=row.id,
            code=code,
            code_prefix=row.code_prefix,
            max_uses=row.max_uses,
            uses_count=row.uses_count,
            expires_at=row.expires_at,
            revoked_at=row.revoked_at,
            created_at=row.created_at,
        )

    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"Failed to generate unique invite code (hash_prefix={last_hash_prefix})",
    )


@router.post(
    "/{invite_id}:revoke",
    response_model=InviteCodeListItem,
    operation_id="admin_invites_revoke",
)
async def admin_invites_revoke(
    invite_id: str,
    admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> InviteCodeListItem:
    now = datetime.utcnow()
    row = db.get(InviteCode, invite_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    if row.revoked_at is None:
        row.revoked_at = now
        row.updated_at = now
        db.add(
            AuditLog(
                actor=f"admin:{admin.id}",
                action="invite_code.revoke",
                target_type="invite_code",
                target_id=row.id,
                metadata_json=_canonical_json(
                    {
                        "code_prefix": row.code_prefix,
                        "code_hash_prefix": row.code_hash[:8],
                        "revoked_at": now.isoformat(),
                    }
                ),
                created_at=now,
            )
        )
        db.commit()
    else:
        db.commit()

    return InviteCodeListItem(
        id=row.id,
        code_prefix=row.code_prefix,
        max_uses=row.max_uses,
        uses_count=row.uses_count,
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
        created_at=row.created_at,
    )


@router.get(
    "",
    response_model=InviteCodeListResponse,
    operation_id="admin_invites_list",
)
async def admin_invites_list(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> InviteCodeListResponse:
    stmt = (
        select(InviteCode)
        .order_by(InviteCode.created_at.desc(), InviteCode.id.desc())
        .offset(offset)
        .limit(limit + 1)
    )
    rows = list(db.execute(stmt).scalars().all())
    more = len(rows) > limit
    page = rows[:limit]

    items = [
        InviteCodeListItem(
            id=r.id,
            code_prefix=r.code_prefix,
            max_uses=r.max_uses,
            uses_count=r.uses_count,
            expires_at=r.expires_at,
            revoked_at=r.revoked_at,
            created_at=r.created_at,
        )
        for r in page
    ]
    return InviteCodeListResponse(
        items=items,
        next_offset=(offset + len(page)) if more else None,
    )


@router.get(
    "/{invite_id}/redemptions",
    response_model=InviteRedemptionListResponse,
    operation_id="admin_invites_redemptions_list",
)
async def admin_invites_redemptions_list(
    invite_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> InviteRedemptionListResponse:
    exists = db.get(InviteCode, invite_id)
    if exists is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")

    stmt = (
        select(InviteRedemption)
        .where(InviteRedemption.invite_id == invite_id)
        .order_by(InviteRedemption.used_at.asc(), InviteRedemption.id.asc())
        .offset(offset)
        .limit(limit + 1)
    )
    rows = list(db.execute(stmt).scalars().all())
    more = len(rows) > limit
    page = rows[:limit]
    items = [
        InviteRedemptionListItem(
            id=r.id,
            invite_id=r.invite_id,
            user_id=r.user_id,
            user_email=r.user_email,
            used_at=r.used_at,
        )
        for r in page
    ]
    return InviteRedemptionListResponse(
        items=items,
        next_offset=(offset + len(page)) if more else None,
    )
