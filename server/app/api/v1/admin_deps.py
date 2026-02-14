# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from typing import NoReturn

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import AdminUser
from app.db.session import get_db


_bearer_scheme = HTTPBearer(auto_error=False)


def _unauthorized(detail: str = "Unauthorized") -> NoReturn:
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def _forbidden(detail: str = "Forbidden") -> NoReturn:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def get_current_admin_user(
    db: Session = Depends(get_db),
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> AdminUser:
    if creds is None:
        _unauthorized()
    if creds.scheme.lower() != "bearer" or creds.credentials == "":
        _unauthorized()

    try:
        payload = decode_access_token(creds.credentials, settings.admin_access_token_secret)
    except Exception:
        _unauthorized()

    typ = payload.get("typ")
    if typ != "admin":
        _unauthorized()
    sub = payload.get("sub")
    if not isinstance(sub, str) or sub == "":
        _unauthorized()

    admin = db.get(AdminUser, sub)
    if admin is None or not admin.is_active:
        _unauthorized()
    if admin.role not in ("super_admin", "operator"):
        _unauthorized()
    return admin


def require_super_admin(admin: AdminUser = Depends(get_current_admin_user)) -> AdminUser:
    if admin.role != "super_admin":
        _forbidden("Requires super_admin")
    return admin
