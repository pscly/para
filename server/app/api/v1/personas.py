# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import Persona
from app.db.session import get_db


router = APIRouter(prefix="/personas", tags=["personas"])

_bearer_scheme = HTTPBearer(auto_error=False)


class PersonaListItem(BaseModel):
    id: str
    name: str
    version: int


class PersonaDetail(BaseModel):
    id: str
    name: str
    version: int
    prompt: str


def _unauthorized(detail: str = "Unauthorized") -> NoReturn:
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


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


def require_user_id(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> str:
    return _get_current_user_id(creds)


@router.get(
    "",
    response_model=list[PersonaListItem],
    operation_id="personas_list",
)
async def personas_list(
    db: Session = Depends(get_db),
    _user_id: str = Depends(require_user_id),
) -> list[PersonaListItem]:
    personas = db.execute(select(Persona).order_by(Persona.name.asc())).scalars().all()
    return [PersonaListItem(id=p.id, name=p.name, version=p.version) for p in personas]


@router.get(
    "/{persona_id}",
    response_model=PersonaDetail,
    operation_id="personas_get",
)
async def personas_get(
    persona_id: str,
    db: Session = Depends(get_db),
    _user_id: str = Depends(require_user_id),
) -> PersonaDetail:
    persona = db.get(Persona, persona_id)
    if persona is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found")
    return PersonaDetail(
        id=persona.id,
        name=persona.name,
        version=persona.version,
        prompt=persona.prompt,
    )
