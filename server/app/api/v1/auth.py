# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.email import normalize_email
from app.core import security as core_security
from app.core.security import (
    decode_access_token,
    encode_access_token,
    hash_password,
    hash_password_reset_token,
    hash_refresh_token,
    new_refresh_token,
    validate_password_policy,
    verify_password,
)
from app.db.models import (
    Device,
    InviteCode,
    InviteRedemption,
    PasswordResetToken,
    RefreshToken,
    User,
)
from app.db.session import get_db
from app.services.auth_rate_limit import AuthRateLimiter, auth_rate_limit_key


router = APIRouter(prefix="/auth", tags=["auth"])

_bearer_scheme = HTTPBearer(auto_error=False)


class RegisterRequest(BaseModel):
    email: str = Field(..., examples=["user@example.com"])
    password: str = Field(..., min_length=8, examples=["password123"])
    invite_code: str | None = Field(None, examples=["ABCDEFGH1234"])


class LoginRequest(BaseModel):
    email: str = Field(..., examples=["user@example.com"])
    password: str = Field(..., examples=["password123"])


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class PasswordResetRequest(BaseModel):
    email: str = Field(..., examples=["user@example.com"])


class PasswordResetConfirmRequest(BaseModel):
    email: str = Field(..., examples=["user@example.com"])
    token: str = Field(..., examples=["<token>"])
    new_password: str = Field(..., min_length=8, examples=["password123"])


class PasswordResetAcceptedResponse(BaseModel):
    status: str = "accepted"


class PasswordResetConfirmResponse(BaseModel):
    status: str = "ok"


class MeResponse(BaseModel):
    user_id: str
    email: str


def _unauthorized(detail: str = "Unauthorized") -> NoReturn:
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
    )


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
async def register(
    payload: RegisterRequest, request: Request, db: Session = Depends(get_db)
) -> TokenPair:
    limiter = _rate_limiter()
    key = auth_rate_limit_key(scope="auth_register", ip=_client_ip(request), identifier=None)
    try:
        check = limiter.check(db, key=key)
        if check.blocked:
            _raise_rate_limited(retry_after_seconds=check.retry_after_seconds)
    except HTTPException:
        raise
    except Exception:
        pass

    email = normalize_email(payload.email)

    try:
        validate_password_policy(payload.password)
    except ValueError:
        _maybe_record_failure(db, limiter, key=key)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password does not meet security requirements",
        )

    invite_raw = (payload.invite_code or "").strip()
    invite_required = settings.env.strip().lower() in ("prod", "production")
    if invite_required and invite_raw == "":
        _maybe_record_failure(db, limiter, key=key)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="invite_code_required",
        )

    now = datetime.utcnow()
    reserved_invite: InviteCode | None = None
    if invite_raw != "":
        invite_hash = hashlib.sha256(invite_raw.encode("utf-8")).hexdigest()
        reserved_invite = db.execute(
            select(InviteCode).where(InviteCode.code_hash == invite_hash).with_for_update()
        ).scalar_one_or_none()
        if reserved_invite is None:
            _maybe_record_failure(db, limiter, key=key)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="invite_code_invalid",
            )
        if reserved_invite.revoked_at is not None:
            _maybe_record_failure(db, limiter, key=key)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="invite_code_revoked",
            )
        if reserved_invite.expires_at is not None and reserved_invite.expires_at <= now:
            _maybe_record_failure(db, limiter, key=key)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="invite_code_expired",
            )
        if reserved_invite.uses_count >= reserved_invite.max_uses:
            _maybe_record_failure(db, limiter, key=key)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="invite_code_exhausted",
            )
        reserved_invite.uses_count += 1
        reserved_invite.updated_at = now

    existing = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if existing is not None:
        _maybe_record_failure(db, limiter, key=key)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already exists")

    user = User(email=email, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        _maybe_record_failure(db, limiter, key=key)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already exists")

    if reserved_invite is not None:
        db.add(
            InviteRedemption(
                invite_id=reserved_invite.id,
                user_id=user.id,
                user_email=email,
                used_at=now,
            )
        )

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
    limiter.reset(db, key=key)
    db.commit()

    return TokenPair(access_token=access, refresh_token=refresh_raw)


@router.post(
    "/login",
    response_model=TokenPair,
    operation_id="auth_login",
)
async def login(
    payload: LoginRequest, request: Request, db: Session = Depends(get_db)
) -> TokenPair:
    email = normalize_email(payload.email)
    limiter = _rate_limiter()
    key = auth_rate_limit_key(scope="auth_login", ip=_client_ip(request), identifier=email)
    try:
        check = limiter.check(db, key=key)
        if check.blocked:
            _raise_rate_limited(retry_after_seconds=check.retry_after_seconds)
    except HTTPException:
        raise
    except Exception:
        pass

    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        _maybe_record_failure(db, limiter, key=key)
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
    limiter.reset(db, key=key)
    db.commit()

    return TokenPair(access_token=access, refresh_token=refresh_raw)


@router.post(
    "/refresh",
    response_model=TokenPair,
    operation_id="auth_refresh",
)
async def refresh(
    payload: RefreshRequest, request: Request, db: Session = Depends(get_db)
) -> TokenPair:
    limiter = _rate_limiter()
    key = auth_rate_limit_key(scope="auth_refresh", ip=_client_ip(request), identifier=None)
    try:
        check = limiter.check(db, key=key)
        if check.blocked:
            _raise_rate_limited(retry_after_seconds=check.retry_after_seconds)
    except HTTPException:
        raise
    except Exception:
        pass

    now = datetime.utcnow()
    token_hash = hash_refresh_token(payload.refresh_token)
    rt = db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash)
    ).scalar_one_or_none()
    if rt is None or rt.revoked_at is not None or rt.expires_at <= now:
        _maybe_record_failure(db, limiter, key=key)
        _unauthorized("Invalid refresh token")

    user = db.get(User, rt.user_id)
    if user is None:
        _maybe_record_failure(db, limiter, key=key)
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

    limiter.reset(db, key=key)
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


@router.post(
    "/password_reset/request",
    response_model=PasswordResetAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="auth_password_reset_request",
)
async def password_reset_request(
    payload: PasswordResetRequest,
    db: Session = Depends(get_db),
) -> PasswordResetAcceptedResponse:
    email = normalize_email(payload.email)
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is not None:
        now = datetime.utcnow()
        raw = core_security.new_password_reset_token()
        token_hash = hash_password_reset_token(raw)
        row = PasswordResetToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=now + timedelta(minutes=settings.password_reset_token_ttl_minutes),
            used_at=None,
        )
        db.add(row)
        db.commit()

    return PasswordResetAcceptedResponse()


@router.post(
    "/password_reset/confirm",
    response_model=PasswordResetConfirmResponse,
    operation_id="auth_password_reset_confirm",
)
async def password_reset_confirm(
    payload: PasswordResetConfirmRequest,
    db: Session = Depends(get_db),
) -> PasswordResetConfirmResponse:
    email = normalize_email(payload.email)

    try:
        validate_password_policy(payload.new_password)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password does not meet security requirements",
        )

    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid token")

    now = datetime.utcnow()
    try:
        token_hash = hash_password_reset_token(payload.token)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid token")
    prt = db.execute(
        select(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.token_hash == token_hash,
            PasswordResetToken.used_at.is_(None),
        )
        .with_for_update()
    ).scalar_one_or_none()
    if prt is None or prt.expires_at <= now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid token")

    user.password_hash = hash_password(payload.new_password)
    prt.used_at = now

    devices = (
        db.execute(select(Device).where(Device.user_id == user.id, Device.revoked_at.is_(None)))
        .scalars()
        .all()
    )
    for d in devices:
        d.revoked_at = now

    tokens = (
        db.execute(
            select(RefreshToken).where(
                RefreshToken.user_id == user.id,
                RefreshToken.revoked_at.is_(None),
            )
        )
        .scalars()
        .all()
    )
    for t in tokens:
        t.revoked_at = now

    db.commit()
    return PasswordResetConfirmResponse()
