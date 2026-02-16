from __future__ import annotations

from datetime import datetime, timezone
from typing import TypedDict, cast

from sqlalchemy import func, select, text

from app.core.security import JSONValue
from app.db.models import WsDeviceCursor, WsEvent, WsStream
from app.db.session import SessionLocal
from app.ws.redis_notify import publish_ws_v1_append_notify


PROTOCOL_VERSION = 1


class WSFrame(TypedDict, total=True):
    protocol_version: int
    type: str
    seq: int
    cursor: int
    server_event_id: str | None
    ack_required: bool
    payload: JSONValue


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def append_typed_event(
    *,
    user_id: str,
    save_id: str,
    frame_type: str,
    payload: JSONValue,
    ack_required: bool = True,
) -> WSFrame:
    now = _utcnow_naive()

    seq: int

    with SessionLocal() as db:
        with db.begin():
            _ = db.execute(
                text(
                    """
                    INSERT INTO ws_streams (user_id, save_id, next_seq, trimmed_upto_seq, created_at, updated_at)
                    VALUES (:user_id, :save_id, 1, 0, :now, :now)
                    ON CONFLICT (user_id, save_id) DO NOTHING
                    """
                ),
                {"user_id": user_id, "save_id": save_id, "now": now},
            )

            row = (
                db.execute(
                    text(
                        """
                        UPDATE ws_streams
                        SET next_seq = next_seq + 1, updated_at = :now
                        WHERE user_id = :user_id AND save_id = :save_id
                        RETURNING (next_seq - 1) AS seq
                        """
                    ),
                    {"user_id": user_id, "save_id": save_id, "now": now},
                )
                .mappings()
                .one()
            )

            seq = int(cast(int, row["seq"]))

            ev = WsEvent(
                user_id=user_id,
                save_id=save_id,
                seq=seq,
                frame_type=str(frame_type),
                payload_json=payload,
                ack_required=bool(ack_required),
                created_at=now,
            )
            db.add(ev)

        # 必须在事务提交成功后再通知，避免通知先到但 DB 无事件。
        publish_ws_v1_append_notify(user_id=user_id, save_id=save_id, seq=seq)

    return {
        "protocol_version": PROTOCOL_VERSION,
        "type": str(frame_type),
        "seq": seq,
        "cursor": seq,
        "server_event_id": f"{user_id}:{save_id}:{seq}",
        "ack_required": bool(ack_required),
        "payload": payload,
    }


def append_event(
    *, user_id: str, save_id: str, payload: JSONValue, ack_required: bool = True
) -> WSFrame:
    return append_typed_event(
        user_id=user_id,
        save_id=save_id,
        frame_type="EVENT",
        payload=payload,
        ack_required=ack_required,
    )


def ensure_device_cursor(*, user_id: str, save_id: str, device_id: str) -> None:
    if device_id.strip() == "":
        device_id = "legacy"
    now = _utcnow_naive()

    with SessionLocal() as db:
        with db.begin():
            _ = db.execute(
                text(
                    """
                    INSERT INTO ws_device_cursors (user_id, save_id, device_id, last_acked_seq, created_at, updated_at)
                    VALUES (:user_id, :save_id, :device_id, 0, :now, :now)
                    ON CONFLICT (user_id, save_id, device_id) DO NOTHING
                    """
                ),
                {"user_id": user_id, "save_id": save_id, "device_id": device_id, "now": now},
            )


def device_cursor_exists(*, user_id: str, save_id: str, device_id: str) -> bool:
    if device_id.strip() == "":
        device_id = "legacy"
    with SessionLocal() as db:
        row = db.get(
            WsDeviceCursor, {"user_id": user_id, "save_id": save_id, "device_id": device_id}
        )
        return row is not None


def count_device_cursors(*, user_id: str, save_id: str) -> int:
    with SessionLocal() as db:
        stmt = (
            select(func.count())
            .select_from(WsDeviceCursor)
            .where(WsDeviceCursor.user_id == user_id, WsDeviceCursor.save_id == save_id)
        )
        cnt = db.execute(stmt).scalar_one()
        return int(cnt)


def get_device_last_acked_seq(*, user_id: str, save_id: str, device_id: str) -> int:
    if device_id.strip() == "":
        device_id = "legacy"
    with SessionLocal() as db:
        row = db.get(
            WsDeviceCursor, {"user_id": user_id, "save_id": save_id, "device_id": device_id}
        )
        if row is None:
            return 0
        return int(row.last_acked_seq)


def get_trimmed_upto_seq(*, user_id: str, save_id: str) -> int:
    with SessionLocal() as db:
        row = db.get(WsStream, {"user_id": user_id, "save_id": save_id})
        if row is None:
            return 0
        return int(row.trimmed_upto_seq)


def get_events_after(*, user_id: str, save_id: str, resume_from: int) -> list[WSFrame]:
    if resume_from < 0:
        return []

    with SessionLocal() as db:
        stream = db.get(WsStream, {"user_id": user_id, "save_id": save_id})
        trimmed_upto = int(stream.trimmed_upto_seq) if stream is not None else 0
        effective_resume_from = max(int(resume_from), trimmed_upto)

        stmt = (
            select(WsEvent)
            .where(
                WsEvent.user_id == user_id,
                WsEvent.save_id == save_id,
                WsEvent.seq > effective_resume_from,
            )
            .order_by(WsEvent.seq.asc())
        )
        rows = [row for row in db.execute(stmt).scalars().all()]

    out: list[WSFrame] = []
    for ev in rows:
        seq = int(ev.seq)
        payload = cast(JSONValue, ev.payload_json)
        out.append(
            {
                "protocol_version": PROTOCOL_VERSION,
                "type": str(ev.frame_type),
                "seq": seq,
                "cursor": seq,
                "server_event_id": f"{user_id}:{save_id}:{seq}",
                "ack_required": bool(ev.ack_required),
                "payload": payload,
            }
        )
    return out


def ack_device_cursor_and_maybe_trim(
    *,
    user_id: str,
    save_id: str,
    device_id: str,
    cursor: int,
) -> int:
    if cursor < 0:
        return 0
    if device_id.strip() == "":
        device_id = "legacy"

    now = _utcnow_naive()
    bounded: int

    with SessionLocal() as db:
        with db.begin():
            _ = db.execute(
                text(
                    """
                    INSERT INTO ws_streams (user_id, save_id, next_seq, trimmed_upto_seq, created_at, updated_at)
                    VALUES (:user_id, :save_id, 1, 0, :now, :now)
                    ON CONFLICT (user_id, save_id) DO NOTHING
                    """
                ),
                {"user_id": user_id, "save_id": save_id, "now": now},
            )

            stream = (
                db.execute(
                    select(WsStream).where(WsStream.user_id == user_id, WsStream.save_id == save_id)
                )
                .scalars()
                .one()
            )

            max_seq_in_log = max(0, int(stream.next_seq) - 1)
            bounded = min(int(cursor), max_seq_in_log)

            _ = db.execute(
                text(
                    """
                    INSERT INTO ws_device_cursors (user_id, save_id, device_id, last_acked_seq, created_at, updated_at)
                    VALUES (:user_id, :save_id, :device_id, :last_acked_seq, :now, :now)
                    ON CONFLICT (user_id, save_id, device_id)
                    DO UPDATE SET
                        last_acked_seq = GREATEST(ws_device_cursors.last_acked_seq, EXCLUDED.last_acked_seq),
                        updated_at = EXCLUDED.updated_at
                    """
                ),
                {
                    "user_id": user_id,
                    "save_id": save_id,
                    "device_id": device_id,
                    "last_acked_seq": bounded,
                    "now": now,
                },
            )

            min_acked = db.execute(
                select(func.coalesce(func.min(WsDeviceCursor.last_acked_seq), 0))
                .select_from(WsDeviceCursor)
                .where(
                    WsDeviceCursor.user_id == user_id,
                    WsDeviceCursor.save_id == save_id,
                )
            ).scalar_one()
            min_acked_i = int(min_acked)
            current_trimmed = int(stream.trimmed_upto_seq)

            if min_acked_i > current_trimmed:
                stream.trimmed_upto_seq = min_acked_i
                stream.updated_at = now

                _ = db.execute(
                    text(
                        """
                        DELETE FROM ws_events
                        WHERE user_id = :user_id AND save_id = :save_id AND seq <= :trim_to
                        """
                    ),
                    {"user_id": user_id, "save_id": save_id, "trim_to": min_acked_i},
                )

    return int(bounded)
