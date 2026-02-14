# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from datetime import datetime
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import JSONValue, decode_access_token
from app.db.models import Room, RoomMember, Save
from app.db.session import get_db
from app.ws.v1 import append_typed_event


router = APIRouter(prefix="/social", tags=["social"])

_bearer_scheme = HTTPBearer(auto_error=False)


class RoomCreateRequest(BaseModel):
    room_type: str = Field("social", min_length=1, max_length=50)


class RoomCreateResponse(BaseModel):
    id: str
    room_type: str
    created_by_user_id: str
    created_at: str


class RoomInviteRequest(BaseModel):
    target_user_id: str = Field(..., min_length=1)


class RoomInviteResponse(BaseModel):
    room_id: str
    actor_user_id: str
    target_user_id: str
    status: str


class RoomJoinResponse(BaseModel):
    room_id: str
    actor_user_id: str
    target_user_id: str
    status: str


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


def _append_room_event_for_user_saves(
    db: Session,
    *,
    user_id: str,
    payload: dict[str, JSONValue],
) -> None:
    stmt = select(Save.id).where(Save.user_id == user_id, Save.deleted_at.is_(None))
    save_ids = [row for row in db.execute(stmt).scalars().all()]
    for save_id in save_ids:
        _ = append_typed_event(
            (user_id, save_id),
            frame_type="ROOM_EVENT",
            payload=payload,
            ack_required=True,
        )


def _require_room_or_404(db: Session, *, room_id: str) -> Room:
    room = db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return room


def _require_actor_can_manage_room(db: Session, *, room: Room, actor_user_id: str) -> None:
    if room.created_by_user_id == actor_user_id:
        return
    stmt = select(RoomMember).where(
        RoomMember.room_id == room.id,
        RoomMember.user_id == actor_user_id,
        RoomMember.status == "joined",
    )
    member = db.execute(stmt).scalars().first()
    if member is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


@router.post(
    "/rooms",
    response_model=RoomCreateResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="social_rooms_create",
)
async def social_rooms_create(
    payload: RoomCreateRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> RoomCreateResponse:
    now = datetime.utcnow()
    room = Room(room_type=payload.room_type, created_by_user_id=user_id, created_at=now)
    db.add(room)
    db.flush()

    owner = RoomMember(
        room_id=room.id,
        user_id=user_id,
        role="owner",
        status="joined",
        created_at=now,
        joined_at=now,
    )
    db.add(owner)
    db.commit()
    db.refresh(room)

    room_event_payload: dict[str, JSONValue] = {
        "event": "ROOM_CREATED",
        "room_id": room.id,
        "actor_user_id": user_id,
        "target_user_id": user_id,
        "created_at": now.isoformat() + "Z",
    }
    _append_room_event_for_user_saves(db, user_id=user_id, payload=room_event_payload)

    return RoomCreateResponse(
        id=room.id,
        room_type=room.room_type,
        created_by_user_id=room.created_by_user_id,
        created_at=room.created_at.isoformat() + "Z",
    )


@router.post(
    "/rooms/{room_id}/invite",
    response_model=RoomInviteResponse,
    operation_id="social_rooms_invite",
)
async def social_rooms_invite(
    room_id: str,
    payload: RoomInviteRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> RoomInviteResponse:
    now = datetime.utcnow()
    room = _require_room_or_404(db, room_id=room_id)
    _require_actor_can_manage_room(db, room=room, actor_user_id=user_id)

    stmt = select(RoomMember).where(
        RoomMember.room_id == room.id,
        RoomMember.user_id == payload.target_user_id,
    )
    member = db.execute(stmt).scalars().first()
    emit_invited_event = False
    if member is None:
        member = RoomMember(
            room_id=room.id,
            user_id=payload.target_user_id,
            role="member",
            status="invited",
            created_at=now,
            joined_at=None,
        )
        db.add(member)
        emit_invited_event = True
    else:
        if member.status != "joined":
            member.status = "invited"
            member.joined_at = None
            emit_invited_event = True
    db.commit()

    out_status = member.status

    if emit_invited_event:
        room_event_payload: dict[str, JSONValue] = {
            "event": "ROOM_INVITED",
            "room_id": room.id,
            "actor_user_id": user_id,
            "target_user_id": payload.target_user_id,
            "created_at": now.isoformat() + "Z",
        }
        _append_room_event_for_user_saves(db, user_id=user_id, payload=room_event_payload)
        _append_room_event_for_user_saves(
            db, user_id=payload.target_user_id, payload=room_event_payload
        )

    return RoomInviteResponse(
        room_id=room.id,
        actor_user_id=user_id,
        target_user_id=payload.target_user_id,
        status=out_status,
    )


@router.post(
    "/rooms/{room_id}/join",
    response_model=RoomJoinResponse,
    operation_id="social_rooms_join",
)
async def social_rooms_join(
    room_id: str,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> RoomJoinResponse:
    now = datetime.utcnow()
    room = _require_room_or_404(db, room_id=room_id)

    stmt = select(RoomMember).where(
        RoomMember.room_id == room.id,
        RoomMember.user_id == user_id,
    )
    member = db.execute(stmt).scalars().first()
    if member is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not invited")

    if member.status != "joined":
        member.status = "joined"
        member.joined_at = now
        db.commit()

    room_event_payload: dict[str, JSONValue] = {
        "event": "ROOM_JOINED",
        "room_id": room.id,
        "actor_user_id": user_id,
        "target_user_id": user_id,
        "created_at": now.isoformat() + "Z",
    }

    notify_user_ids = {user_id, room.created_by_user_id}
    for uid in notify_user_ids:
        _append_room_event_for_user_saves(db, user_id=uid, payload=room_event_payload)

    return RoomJoinResponse(
        room_id=room.id,
        actor_user_id=user_id,
        target_user_id=user_id,
        status="joined",
    )
