# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.admin_deps import require_super_admin
from app.core.email import normalize_email
from app.db.models import AdminUser, AuditLog, User
from app.db.session import get_db


router = APIRouter(prefix="/admin/users", tags=["admin"])


def _canonical_json(obj: dict[str, object]) -> str:
    try:
        return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Body contains non-JSON-serializable values",
        )


class DebugAllowedGetResponse(BaseModel):
    email: str
    debug_allowed: bool


class DebugAllowedPutRequest(BaseModel):
    email: str = Field(..., min_length=1, max_length=320)
    debug_allowed: bool


@router.get(
    "/debug_allowed",
    response_model=DebugAllowedGetResponse,
    operation_id="admin_users_debug_allowed_get",
)
async def admin_users_debug_allowed_get(
    email: str = Query(..., min_length=1, max_length=320),
    _admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> DebugAllowedGetResponse:
    normalized = normalize_email(email)
    user = db.execute(select(User).where(User.email == normalized)).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return DebugAllowedGetResponse(email=user.email, debug_allowed=bool(user.debug_allowed))


@router.put(
    "/debug_allowed",
    response_model=DebugAllowedGetResponse,
    operation_id="admin_users_debug_allowed_put",
)
async def admin_users_debug_allowed_put(
    payload: DebugAllowedPutRequest,
    admin: AdminUser = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> DebugAllowedGetResponse:
    normalized = normalize_email(payload.email)
    user = db.execute(select(User).where(User.email == normalized)).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    prev = bool(user.debug_allowed)
    next_val = bool(payload.debug_allowed)
    now = datetime.utcnow()

    if prev != next_val:
        user.debug_allowed = next_val
        db.add(
            AuditLog(
                actor=f"admin:{admin.id}",
                action="user.debug_allowed.update",
                target_type="user",
                target_id=user.id,
                metadata_json=_canonical_json(
                    {
                        "email": user.email,
                        "user_id": user.id,
                        "prev": prev,
                        "next": next_val,
                    }
                ),
                created_at=now,
            )
        )

    db.commit()
    return DebugAllowedGetResponse(email=user.email, debug_allowed=bool(user.debug_allowed))
