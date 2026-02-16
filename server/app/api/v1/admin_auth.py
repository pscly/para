# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.email import normalize_email
from app.core.security import encode_access_token, verify_password
from app.db.models import AdminUser
from app.db.session import get_db
from app.services.auth_rate_limit import AuthRateLimiter, auth_rate_limit_key


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


def _rate_limiter() -> AuthRateLimiter:
    return AuthRateLimiter(
        enabled=settings.auth_rate_limit_enabled,
        max_failures=settings.auth_rate_limit_max_failures,
        window_seconds=settings.auth_rate_limit_window_seconds,
    )


def _client_ip(request: Request) -> str | None:
    if request.client is None:
        return None
    return request.client.host


def _raise_rate_limited(*, retry_after_seconds: int) -> NoReturn:
    headers: dict[str, str] | None = None
    if retry_after_seconds > 0:
        headers = {"Retry-After": str(int(retry_after_seconds))}
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many attempts",
        headers=headers,
    )


def _maybe_record_failure(db: Session, limiter: AuthRateLimiter, *, key: str) -> None:
    try:
        limiter.record_failure(db, key=key)
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


@router.post(
    "/login",
    response_model=AdminTokenResponse,
    operation_id="admin_auth_login",
)
async def admin_login(
    payload: AdminLoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> AdminTokenResponse:
    email = normalize_email(payload.email)

    limiter = _rate_limiter()
    key = auth_rate_limit_key(scope="admin_auth_login", ip=_client_ip(request), identifier=email)
    try:
        check = limiter.check(db, key=key)
        if check.blocked:
            _raise_rate_limited(retry_after_seconds=check.retry_after_seconds)
    except HTTPException:
        raise
    except Exception:
        pass

    admin = db.execute(select(AdminUser).where(AdminUser.email == email)).scalar_one_or_none()
    if admin is None or not admin.is_active:
        _maybe_record_failure(db, limiter, key=key)
        _unauthorized("Bad credentials")
    if not verify_password(payload.password, admin.password_hash):
        _maybe_record_failure(db, limiter, key=key)
        _unauthorized("Bad credentials")

    access = encode_access_token(
        {"sub": admin.id, "role": admin.role, "typ": "admin"},
        secret=settings.admin_access_token_secret,
        expires_in_seconds=settings.admin_access_token_ttl_seconds,
    )
    limiter.reset(db, key=key)
    db.commit()
    return AdminTokenResponse(
        access_token=access,
        admin_user_id=admin.id,
        role=admin.role,
    )
