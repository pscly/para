# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import encode_access_token, verify_password
from app.db.models import AdminUser
from app.db.session import get_db


router = APIRouter(prefix="/admin/auth", tags=["admin"])


class AdminLoginRequest(BaseModel):
    email: str = Field(..., examples=["admin@example.com"])
    password: str = Field(..., min_length=8, examples=["password123"])


class AdminTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    admin_user_id: str
    role: str


def _unauthorized(detail: str = "Unauthorized") -> NoReturn:
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


@router.post(
    "/login",
    response_model=AdminTokenResponse,
    operation_id="admin_auth_login",
)
async def admin_login(
    payload: AdminLoginRequest,
    db: Session = Depends(get_db),
) -> AdminTokenResponse:
    admin = db.execute(
        select(AdminUser).where(AdminUser.email == payload.email)
    ).scalar_one_or_none()
    if admin is None or not admin.is_active:
        _unauthorized("Bad credentials")
    if not verify_password(payload.password, admin.password_hash):
        _unauthorized("Bad credentials")

    access = encode_access_token(
        {"sub": admin.id, "role": admin.role, "typ": "admin"},
        secret=settings.admin_access_token_secret,
        expires_in_seconds=settings.admin_access_token_ttl_seconds,
    )
    return AdminTokenResponse(
        access_token=access,
        admin_user_id=admin.id,
        role=admin.role,
    )
