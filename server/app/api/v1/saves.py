# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from datetime import datetime
from typing import NoReturn, cast

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import Persona, Save, SavePersonaBinding
from app.db.session import get_db


router = APIRouter(prefix="/saves", tags=["saves"])

_bearer_scheme = HTTPBearer(auto_error=False)


class SaveCreateRequest(BaseModel):
    name: str


class SavePatchRequest(BaseModel):
    name: str | None = None


class SaveCreateResponse(BaseModel):
    id: str
    name: str
    created_at: datetime


class SaveResponse(BaseModel):
    id: str
    name: str
    created_at: datetime
    deleted_at: datetime | None


class SaveListItem(BaseModel):
    id: str
    name: str
    created_at: datetime
    deleted_at: datetime | None
    persona_id: str | None = None


class SaveBindPersonaRequest(BaseModel):
    persona_id: str


class SaveBindPersonaResponse(BaseModel):
    save_id: str
    persona_id: str
    bound_at: datetime


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


def _get_owned_save_or_404(db: Session, *, user_id: str, save_id: str) -> Save:
    save = db.get(Save, save_id)
    if save is None or save.user_id != user_id or save.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Save not found")
    return save


@router.get(
    "",
    response_model=list[SaveListItem],
    operation_id="saves_list",
)
async def saves_list(
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> list[SaveListItem]:
    stmt = (
        select(Save, SavePersonaBinding.persona_id)
        .outerjoin(SavePersonaBinding, SavePersonaBinding.save_id == Save.id)
        .where(Save.user_id == user_id, Save.deleted_at.is_(None))
        .order_by(Save.created_at.desc())
    )
    rows = cast(list[tuple[Save, str | None]], db.execute(stmt).tuples().all())
    return [
        SaveListItem(
            id=save.id,
            name=save.name,
            created_at=save.created_at,
            deleted_at=save.deleted_at,
            persona_id=persona_id,
        )
        for (save, persona_id) in rows
    ]


@router.post(
    "",
    response_model=SaveCreateResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="saves_create",
)
async def saves_create(
    payload: SaveCreateRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> SaveCreateResponse:
    save = Save(user_id=user_id, name=payload.name, deleted_at=None)
    db.add(save)
    db.commit()
    db.refresh(save)
    return SaveCreateResponse(id=save.id, name=save.name, created_at=save.created_at)


@router.patch(
    "/{save_id}",
    response_model=SaveResponse,
    operation_id="saves_patch",
)
async def saves_patch(
    save_id: str,
    payload: SavePatchRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> SaveResponse:
    save = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)
    if payload.name is not None:
        save.name = payload.name
    db.commit()
    db.refresh(save)
    return SaveResponse(
        id=save.id,
        name=save.name,
        created_at=save.created_at,
        deleted_at=save.deleted_at,
    )


@router.post(
    "/{save_id}/persona",
    response_model=SaveBindPersonaResponse,
    operation_id="saves_bind_persona",
)
async def saves_bind_persona(
    save_id: str,
    payload: SaveBindPersonaRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> SaveBindPersonaResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)
    persona = db.get(Persona, payload.persona_id)
    if persona is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found")

    now = datetime.utcnow()
    binding = db.get(SavePersonaBinding, save_id)
    if binding is None:
        binding = SavePersonaBinding(save_id=save_id, persona_id=persona.id, bound_at=now)
        db.add(binding)
    else:
        binding.persona_id = persona.id
        binding.bound_at = now

    db.commit()
    db.refresh(binding)
    return SaveBindPersonaResponse(
        save_id=binding.save_id,
        persona_id=binding.persona_id,
        bound_at=binding.bound_at,
    )
