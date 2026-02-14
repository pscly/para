# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from typing import NoReturn, Protocol, cast

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import Save
from app.db.session import get_db
from app.workers.celery_app import celery_app
from app.workers.tasks.dreams import task_12_generate_dream_entry


class _AsyncResult(Protocol):
    id: str | None

    def get(self, timeout: float | int | None = None) -> dict[str, object]: ...


class _DreamEntryTask(Protocol):
    def delay(
        self,
        *,
        user_id: str,
        save_id: str,
        kind: str,
        content: str | None,
    ) -> _AsyncResult: ...


router = APIRouter(prefix="/dreams", tags=["dreams"])

_bearer_scheme = HTTPBearer(auto_error=False)


class DreamTriggerRequest(BaseModel):
    save_id: str = Field(..., min_length=1)
    kind: str = Field("dream", min_length=1)
    content: str | None = None


class DreamTriggerResponse(BaseModel):
    task_id: str
    dream_entry_id: str | None = None


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


@router.post(
    "/trigger",
    response_model=DreamTriggerResponse,
    operation_id="dreams_trigger",
)
async def dreams_trigger(
    payload: DreamTriggerRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> DreamTriggerResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=payload.save_id)

    task = cast(_DreamEntryTask, task_12_generate_dream_entry)
    result = task.delay(
        user_id=user_id,
        save_id=payload.save_id,
        kind=payload.kind,
        content=payload.content,
    )

    dream_entry_id: str | None = None
    if bool(getattr(celery_app.conf, "task_always_eager", False)):
        try:
            out = result.get(timeout=5)
            raw_id = out.get("dream_entry_id")
            dream_entry_id = raw_id if isinstance(raw_id, str) and raw_id else None
        except Exception:
            dream_entry_id = None

    return DreamTriggerResponse(task_id=cast(str, result.id), dream_entry_id=dream_entry_id)
