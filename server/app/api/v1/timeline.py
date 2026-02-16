# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import NoReturn, Protocol, cast

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select
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


_CURSOR_PREFIX = "k1_"


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


def _dt_to_wire_utc_z(dt: datetime) -> str:
    return dt.isoformat() + "Z"


def _parse_wire_utc_datetime(s: str) -> datetime:
    try:
        if s.endswith("Z"):
            dt = datetime.fromisoformat(s[:-1] + "+00:00")
        else:
            dt = datetime.fromisoformat(s)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")

    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _encode_cursor_k1(*, created_at: datetime, event_id: str) -> str:
    payload = {"created_at": _dt_to_wire_utc_z(created_at), "id": event_id}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return _CURSOR_PREFIX + _b64url_encode(raw)


def _parse_cursor_keyset(cursor: str | None) -> tuple[datetime, str] | None:
    if cursor is None:
        return None
    c = cursor.strip()
    if c == "" or c == "0":
        return None

    if not c.startswith(_CURSOR_PREFIX):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")

    b64 = c[len(_CURSOR_PREFIX) :]
    if b64 == "":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")

    try:
        raw = _b64url_decode(b64)
        obj_raw = cast(object, json.loads(raw.decode("utf-8")))
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")

    if not isinstance(obj_raw, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")

    obj = cast(dict[str, object], obj_raw)

    created_at_raw = obj.get("created_at")
    event_id_raw = obj.get("id")
    if not isinstance(created_at_raw, str) or not isinstance(event_id_raw, str):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")
    if event_id_raw.strip() == "":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor")

    created_at = _parse_wire_utc_datetime(created_at_raw)
    return (created_at, event_id_raw)


@router.get(
    "",
    response_model=TimelineListResponse,
    operation_id="timeline_list",
)
async def timeline_list(
    *,
    cursor: str | None = None,
    event_type: str | None = Query(None, min_length=1),
    limit: int = Query(20, ge=1, le=200),
    save_id: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> TimelineListResponse:
    keyset = _parse_cursor_keyset(cursor)

    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)

    stmt = select(TimelineEvent).where(
        TimelineEvent.user_id == user_id,
        TimelineEvent.save_id == save_id,
    )

    final_event_type = (event_type or "").strip()
    if final_event_type != "":
        stmt = stmt.where(TimelineEvent.event_type == final_event_type)

    if keyset is not None:
        cursor_created_at, cursor_id = keyset
        stmt = stmt.where(
            or_(
                TimelineEvent.created_at < cursor_created_at,
                and_(TimelineEvent.created_at == cursor_created_at, TimelineEvent.id < cursor_id),
            )
        )

    page_size = int(limit)

    stmt = stmt.order_by(TimelineEvent.created_at.desc(), TimelineEvent.id.desc()).limit(
        page_size + 1
    )

    rows = [row for row in db.execute(stmt).scalars().all()]
    has_more = len(rows) > page_size
    if has_more:
        rows = rows[:page_size]
    items = [
        TimelineListItem(
            id=r.id,
            save_id=r.save_id,
            event_type=r.event_type,
            content=r.content,
            created_at=_dt_to_wire_utc_z(r.created_at),
        )
        for r in rows
    ]

    next_cursor = ""
    if has_more and rows:
        last = rows[-1]
        next_cursor = _encode_cursor_k1(created_at=last.created_at, event_id=last.id)
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
