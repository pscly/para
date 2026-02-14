# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUntypedFunctionDecorator=false
# pyright: reportDeprecated=false
from __future__ import annotations

import random
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Save, TimelineEvent
from app.db.session import engine
from app.workers.celery_app import celery_app
from app.ws.v1 import append_typed_event


def _pick_weighted(choices: list[tuple[str, int]]) -> str:
    total = sum(max(0, int(w)) for _, w in choices)
    if total <= 0:
        return choices[0][0]
    r = random.randint(1, total)
    acc = 0
    for val, w in choices:
        acc += max(0, int(w))
        if r <= acc:
            return val
    return choices[-1][0]


def _generate_event_text(event_type: str) -> str:
    if event_type == "WOKE_UP":
        return "醒来，伸了个懒腰。"
    if event_type == "ATE":
        return "吃了一点东西，心情稳定。"
    if event_type == "WALKED":
        return "散步 10 分钟，呼吸了一会儿。"
    if event_type == "THOUGHT":
        return "想起一段旧事，决定把它写进日记。"
    if event_type == "SOCIAL":
        return "收到了朋友的消息，简单聊了几句。"
    return "发生了一件小事。"


@celery_app.task(name="app.workers.tasks.timeline.task_18_generate_timeline_event")
def task_18_generate_timeline_event(
    user_id: str,
    save_id: str,
    event_type: str | None = None,
    content: str | None = None,
) -> dict[str, object]:
    now = datetime.utcnow()
    final_event_type = (event_type or "").strip() or _pick_weighted(
        [
            ("WOKE_UP", 2),
            ("ATE", 3),
            ("WALKED", 3),
            ("THOUGHT", 2),
            ("SOCIAL", 1),
        ]
    )
    final_content = (content or "").strip() or _generate_event_text(final_event_type)

    with Session(engine) as db:
        ev = TimelineEvent(
            user_id=user_id,
            save_id=save_id,
            event_type=final_event_type,
            content=final_content,
            created_at=now,
        )
        db.add(ev)
        db.commit()
        db.refresh(ev)
        event_id = ev.id

    frame = append_typed_event(
        (user_id, save_id),
        frame_type="TIMELINE_EVENT",
        payload={
            "event": "TIMELINE_EVENT_CREATED",
            "timeline_event": {
                "id": event_id,
                "user_id": user_id,
                "save_id": save_id,
                "event_type": final_event_type,
                "content": final_content,
                "created_at": now.isoformat() + "Z",
            },
        },
        ack_required=True,
    )

    return {
        "timeline_event_id": event_id,
        "ws_frame": {
            "type": frame["type"],
            "seq": frame["seq"],
            "server_event_id": frame["server_event_id"],
        },
    }


@celery_app.task(name="app.workers.tasks.timeline.task_18_generate_timeline_events_for_all_saves")
def task_18_generate_timeline_events_for_all_saves(limit: int = 10) -> dict[str, object]:
    created: list[str] = []
    with Session(engine) as db:
        stmt = (
            select(Save)
            .where(Save.deleted_at.is_(None))
            .order_by(Save.created_at.desc())
            .limit(int(limit))
        )
        saves = [row for row in db.execute(stmt).scalars().all()]

        for s in saves:
            now = datetime.utcnow()
            event_type = _pick_weighted(
                [
                    ("ATE", 4),
                    ("WALKED", 3),
                    ("THOUGHT", 2),
                    ("SOCIAL", 1),
                ]
            )
            content = _generate_event_text(event_type)

            ev = TimelineEvent(
                user_id=s.user_id,
                save_id=s.id,
                event_type=event_type,
                content=content,
                created_at=now,
            )
            db.add(ev)
            db.flush()
            created.append(ev.id)

            _ = append_typed_event(
                (s.user_id, s.id),
                frame_type="TIMELINE_EVENT",
                payload={
                    "event": "TIMELINE_EVENT_CREATED",
                    "timeline_event": {
                        "id": ev.id,
                        "user_id": s.user_id,
                        "save_id": s.id,
                        "event_type": event_type,
                        "content": content,
                        "created_at": now.isoformat() + "Z",
                    },
                },
                ack_required=True,
            )

        db.commit()

    return {"created_count": len(created), "timeline_event_ids": created}
