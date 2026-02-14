# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from typing import NoReturn, Protocol, cast

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import Save, TimelineEvent
from app.db.session import get_db
from app.workers.celery_app import celery_app
from app.workers.tasks.timeline import task_18_generate_timeline_event


class _AsyncResult(Protocol):
    id: str | None

    def get(self, timeout: float | int | None = None) -> dict[str, object]: ...


class _TimelineEventTask(Protocol):
    def delay(
        self,
        *,
        user_id: str,
        save_id: str,
        event_type: str | None,
        content: str | None,
    ) -> _AsyncResult: ...


router = APIRouter(prefix="/timeline", tags=["timeline"])

_bearer_scheme = HTTPBearer(auto_error=False)


class TimelineSimulateRequest(BaseModel):
    save_id: str = Field(..., min_length=1)
    event_type: str | None = None
    content: str | None = None


class TimelineSimulateResponse(BaseModel):
    task_id: str
    timeline_event_id: str | None = None


class TimelineListItem(BaseModel):
    id: str
    save_id: str
    event_type: str
    content: str
    created_at: str


class TimelineListResponse(BaseModel):
    items: list[TimelineListItem]
    next_cursor: str


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


def _parse_cursor_offset(cursor: str | None) -> int:
    if cursor is None or cursor.strip() == "":
        return 0
    try:
        n = int(cursor)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")
    if n < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")
    return n


@router.get(
    "",
    response_model=TimelineListResponse,
    operation_id="timeline_list",
)
async def timeline_list(
    *,
    cursor: str | None = None,
    limit: int = Query(20, ge=1, le=200),
    save_id: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> TimelineListResponse:
    offset = _parse_cursor_offset(cursor)

    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)

    stmt = select(TimelineEvent).where(
        TimelineEvent.user_id == user_id,
        TimelineEvent.save_id == save_id,
    )

    stmt = (
        stmt.order_by(TimelineEvent.created_at.desc(), TimelineEvent.id.desc())
        .offset(offset)
        .limit(int(limit))
    )

    rows = [row for row in db.execute(stmt).scalars().all()]
    items = [
        TimelineListItem(
            id=r.id,
            save_id=r.save_id,
            event_type=r.event_type,
            content=r.content,
            created_at=r.created_at.isoformat() + "Z",
        )
        for r in rows
    ]

    next_cursor = str(offset + len(items))
    return TimelineListResponse(items=items, next_cursor=next_cursor)


@router.post(
    "/simulate",
    response_model=TimelineSimulateResponse,
    operation_id="timeline_simulate",
)
async def timeline_simulate(
    payload: TimelineSimulateRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> TimelineSimulateResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=payload.save_id)

    task = cast(_TimelineEventTask, task_18_generate_timeline_event)
    result = task.delay(
        user_id=user_id,
        save_id=payload.save_id,
        event_type=payload.event_type,
        content=payload.content,
    )

    timeline_event_id: str | None = None
    if bool(getattr(celery_app.conf, "task_always_eager", False)):
        try:
            out = result.get(timeout=5)
            raw_id = out.get("timeline_event_id")
            timeline_event_id = raw_id if isinstance(raw_id, str) and raw_id else None
        except Exception:
            timeline_event_id = None

    return TimelineSimulateResponse(
        task_id=cast(str, result.id),
        timeline_event_id=timeline_event_id,
    )
