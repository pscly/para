# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from datetime import datetime, timedelta
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    decode_access_token,
    encode_access_token,
    hash_password,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)
from app.db.models import Device, RefreshToken, User
from app.db.session import get_db


router = APIRouter(prefix="/auth", tags=["auth"])

_bearer_scheme = HTTPBearer(auto_error=False)


class RegisterRequest(BaseModel):
    email: str = Field(..., examples=["user@example.com"])
    password: str = Field(..., min_length=8, examples=["password123"])


class LoginRequest(BaseModel):
    email: str = Field(..., examples=["user@example.com"])
    password: str = Field(..., examples=["password123"])


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class MeResponse(BaseModel):
    user_id: str
    email: str


def _unauthorized(detail: str = "Unauthorized") -> NoReturn:
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
    )


def _get_current_user_id(creds: HTTPAuthorizationCredentials | None) -> str:
    if creds is None:
        _unauthorized()
    if creds.scheme.lower() != "bearer" or creds.credentials == "":
        _unauthorized()
    try:
        payload = decode_access_token(creds.credentials, settings.auth_access_token_secret)
    except Exception:
        _unauthorized()

    sub = payload.get("sub")
    if not isinstance(sub, str) or sub == "":
        _unauthorized()
    return sub


def _issue_token_pair(user: User) -> tuple[str, str, str]:
    access = encode_access_token(
        {"sub": user.id},
        secret=settings.auth_access_token_secret,
        expires_in_seconds=settings.auth_access_token_ttl_seconds,
    )
    refresh_raw = new_refresh_token()
    refresh_hash = hash_refresh_token(refresh_raw)
    return access, refresh_raw, refresh_hash


@router.post(
    "/register",
    response_model=TokenPair,
    status_code=status.HTTP_201_CREATED,
    operation_id="auth_register",
)
async def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> TokenPair:
    existing = db.execute(select(User).where(User.email == payload.email)).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already exists")

    user = User(email=payload.email, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already exists")

    device = Device(user_id=user.id, name=None, last_seen_at=datetime.utcnow(), revoked_at=None)
    db.add(device)
    db.flush()

    access, refresh_raw, refresh_hash = _issue_token_pair(user)
    rt = RefreshToken(
        user_id=user.id,
        device_id=device.id,
        token_hash=refresh_hash,
        expires_at=datetime.utcnow() + timedelta(days=settings.auth_refresh_token_ttl_days),
        revoked_at=None,
    )
    db.add(rt)
    db.commit()

    return TokenPair(access_token=access, refresh_token=refresh_raw)


@router.post(
    "/login",
    response_model=TokenPair,
    operation_id="auth_login",
)
async def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenPair:
    user = db.execute(select(User).where(User.email == payload.email)).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        _unauthorized("Bad credentials")

    device = Device(user_id=user.id, name=None, last_seen_at=datetime.utcnow(), revoked_at=None)
    db.add(device)
    db.flush()

    access, refresh_raw, refresh_hash = _issue_token_pair(user)
    rt = RefreshToken(
        user_id=user.id,
        device_id=device.id,
        token_hash=refresh_hash,
        expires_at=datetime.utcnow() + timedelta(days=settings.auth_refresh_token_ttl_days),
        revoked_at=None,
    )
    db.add(rt)
    db.commit()

    return TokenPair(access_token=access, refresh_token=refresh_raw)


@router.post(
    "/refresh",
    response_model=TokenPair,
    operation_id="auth_refresh",
)
async def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenPair:
    now = datetime.utcnow()
    token_hash = hash_refresh_token(payload.refresh_token)
    rt = db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash)
    ).scalar_one_or_none()
    if rt is None or rt.revoked_at is not None or rt.expires_at <= now:
        _unauthorized("Invalid refresh token")

    user = db.get(User, rt.user_id)
    if user is None:
        _unauthorized("Invalid refresh token")

    # Rotate refresh token: revoke old, mint new
    rt.revoked_at = now

    access, refresh_raw, refresh_hash = _issue_token_pair(user)
    new_rt = RefreshToken(
        user_id=rt.user_id,
        device_id=rt.device_id,
        token_hash=refresh_hash,
        expires_at=now + timedelta(days=settings.auth_refresh_token_ttl_days),
        revoked_at=None,
    )
    db.add(new_rt)

    device = db.get(Device, rt.device_id)
    if device is not None and device.revoked_at is None:
        device.last_seen_at = now

    db.commit()
    return TokenPair(access_token=access, refresh_token=refresh_raw)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="auth_logout",
)
async def logout(
    db: Session = Depends(get_db),
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> None:
    user_id = _get_current_user_id(creds)
    now = datetime.utcnow()

    # Revoke all active device sessions for this user.
    devices = (
        db.execute(select(Device).where(Device.user_id == user_id, Device.revoked_at.is_(None)))
        .scalars()
        .all()
    )
    for d in devices:
        d.revoked_at = now

    tokens = (
        db.execute(
            select(RefreshToken).where(
                RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)
            )
        )
        .scalars()
        .all()
    )
    for t in tokens:
        t.revoked_at = now

    db.commit()
    return None


@router.get(
    "/me",
    response_model=MeResponse,
    operation_id="auth_me",
)
async def me(
    db: Session = Depends(get_db),
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> MeResponse:
    user_id = _get_current_user_id(creds)
    user = db.get(User, user_id)
    if user is None:
        _unauthorized()
    return MeResponse(user_id=user.id, email=user.email)
