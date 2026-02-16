from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import TypeAlias, TypedDict, cast

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from app.core.config import settings
from app.core.security import JSONValue, decode_access_token
from app.db.models import Save
from app.db.session import SessionLocal
from app.ws.chat_fake import LLMStreamCapture, stream_chat_tokens
from app.metrics.prometheus import LLMChatMetricLabels, record_llm_chat_stream
from app.db.models import LLMUsageEvent


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


from app.ws.event_store import (
    ack_device_cursor_and_maybe_trim as _ack_device_cursor_and_maybe_trim,
    append_typed_event as _append_typed_event_db,
    count_device_cursors as _count_device_cursors,
    device_cursor_exists as _device_cursor_exists,
    ensure_device_cursor as _ensure_device_cursor,
    get_device_last_acked_seq as _get_device_last_acked_seq,
    get_events_after as _get_events_after_db,
)
from app.ws.redis_notify import (
    close_async_redis_pubsub,
    decode_ws_v1_append_notify,
    subscribe_ws_v1_stream,
)


PROTOCOL_VERSION = 1

StreamKey: TypeAlias = tuple[str, str]


class WSFrame(TypedDict, total=True):
    protocol_version: int
    type: str
    seq: int
    cursor: int
    server_event_id: str | None
    ack_required: bool
    payload: JSONValue


def append_event(stream_key: StreamKey, payload: JSONValue, ack_required: bool = True) -> WSFrame:
    user_id, save_id = stream_key
    return _append_typed_event_db(
        user_id=user_id,
        save_id=save_id,
        frame_type="EVENT",
        payload=payload,
        ack_required=ack_required,
    )


def append_typed_event(
    stream_key: StreamKey,
    *,
    frame_type: str,
    payload: JSONValue,
    ack_required: bool = True,
) -> WSFrame:
    user_id, save_id = stream_key
    return _append_typed_event_db(
        user_id=user_id,
        save_id=save_id,
        frame_type=frame_type,
        payload=payload,
        ack_required=ack_required,
    )


def get_events_after(stream_key: StreamKey, resume_from: int) -> list[WSFrame]:
    user_id, save_id = stream_key
    return _get_events_after_db(user_id=user_id, save_id=save_id, resume_from=resume_from)


def _control_frame(*, frame_type: str, cursor: int, payload: JSONValue = None) -> WSFrame:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "type": frame_type,
        "seq": 0,
        "cursor": int(cursor),
        "server_event_id": None,
        "ack_required": False,
        "payload": payload,
    }


def _parse_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2:
        return None
    scheme, token = parts[0].strip(), parts[1].strip()
    if scheme.lower() != "bearer" or token == "":
        return None
    return token


def _get_user_id_from_access_token(token: str) -> str | None:
    try:
        payload = decode_access_token(token, settings.auth_access_token_secret)
    except Exception:
        return None
    sub = payload.get("sub")
    return sub if isinstance(sub, str) and sub != "" else None


def _normalize_device_id(device_id: str | None) -> str:
    if device_id is None or device_id.strip() == "":
        return "legacy"
    return device_id.strip()


def _is_owned_save(*, user_id: str, save_id: str) -> bool:
    with SessionLocal() as db:
        save = db.get(Save, save_id)
        if save is None:
            return False
        if save.user_id != user_id:
            return False
        if save.deleted_at is not None:
            return False
        return True


router = APIRouter()


@router.websocket("/ws/v1")
async def ws_v1(websocket: WebSocket) -> None:
    save_id = websocket.query_params.get("save_id")
    resume_from_raw = websocket.query_params.get("resume_from")
    device_id = _normalize_device_id(websocket.query_params.get("device_id"))
    if not save_id or resume_from_raw is None:
        await websocket.close(code=1008)
        return
    try:
        resume_from = int(resume_from_raw)
    except Exception:
        await websocket.close(code=1008)
        return
    if resume_from < 0:
        await websocket.close(code=1008)
        return

    token = _parse_bearer_token(websocket.headers.get("authorization"))
    if token is None:
        await websocket.close(code=1008)
        return
    user_id = _get_user_id_from_access_token(token)
    if user_id is None:
        await websocket.close(code=1008)
        return

    owned = await asyncio.to_thread(_is_owned_save, user_id=user_id, save_id=save_id)
    if not owned:
        await websocket.close(code=1008)
        return

    if len(device_id) > int(settings.ws_max_device_id_length):
        await websocket.close(code=1008)
        return

    stream_key: StreamKey = (user_id, save_id)
    device_exists = await asyncio.to_thread(
        _device_cursor_exists, user_id=user_id, save_id=save_id, device_id=device_id
    )
    if not device_exists:
        device_count = await asyncio.to_thread(
            _count_device_cursors, user_id=user_id, save_id=save_id
        )
        if device_count >= settings.ws_max_devices_per_save:
            await websocket.close(code=1008)
            return

    await asyncio.to_thread(
        _ensure_device_cursor, user_id=user_id, save_id=save_id, device_id=device_id
    )

    await websocket.accept()

    send_lock = asyncio.Lock()
    last_sent_seq = 0
    interrupt_event: asyncio.Event | None = None
    stream_task: asyncio.Task[None] | None = None
    tail_task: asyncio.Task[None] | None = None

    hello_cursor = await asyncio.to_thread(
        _get_device_last_acked_seq, user_id=user_id, save_id=save_id, device_id=device_id
    )

    async def _safe_send_json(frame: WSFrame) -> None:
        nonlocal last_sent_seq
        async with send_lock:
            seq_obj = cast(object, frame.get("seq"))
            seq_i: int | None = seq_obj if isinstance(seq_obj, int) else None
            if seq_i is not None and seq_i > 0 and seq_i <= last_sent_seq:
                return
            await websocket.send_json(frame)
            if seq_i is not None and seq_i > 0:
                last_sent_seq = max(last_sent_seq, seq_i)

    async def _get_last_sent_seq() -> int:
        async with send_lock:
            return int(last_sent_seq)

    await _safe_send_json(
        _control_frame(
            frame_type="HELLO",
            cursor=hello_cursor,
            payload={"user_id": user_id, "save_id": save_id},
        )
    )

    replay_events = await asyncio.to_thread(get_events_after, stream_key, resume_from)
    for event in replay_events:
        await _safe_send_json(event)

    async def _drain_db_events_after_last_sent_seq() -> None:
        resume_from_snapshot = await _get_last_sent_seq()
        events = await asyncio.to_thread(
            _get_events_after_db,
            user_id=user_id,
            save_id=save_id,
            resume_from=resume_from_snapshot,
        )
        for ev in events:
            await _safe_send_json(ev)

    async def _run_ws_v1_redis_tail() -> None:
        try:
            r, pubsub, channel = await subscribe_ws_v1_stream(user_id=user_id, save_id=save_id)
        except Exception:
            return

        try:
            await _drain_db_events_after_last_sent_seq()
            async for msg in pubsub.listen():
                if not isinstance(msg, dict):
                    continue
                msg_dict = cast(dict[str, object], msg)
                if msg_dict.get("type") != "message":
                    continue
                notify = decode_ws_v1_append_notify(msg_dict.get("data"))
                if notify is None:
                    continue
                if notify["user_id"] != user_id or notify["save_id"] != save_id:
                    continue
                await _drain_db_events_after_last_sent_seq()
        except asyncio.CancelledError:
            raise
        except WebSocketDisconnect:
            return
        except RuntimeError:
            return
        except Exception:
            return
        finally:
            try:
                await close_async_redis_pubsub(r=r, pubsub=pubsub, channel=channel)
            except Exception:
                pass

    async def _run_chat_stream(
        *, text: str, client_request_id: str | None, stop: asyncio.Event
    ) -> None:
        started_at = _utcnow_naive()
        start_mono = time.monotonic()
        ttft_ms: int | None = None
        output_chunks = 0
        output_chars = 0
        capture = LLMStreamCapture()

        interrupted = False
        error: str | None = None
        try:
            async for token in stream_chat_tokens(text, stop=stop, capture=capture):
                if stop.is_set():
                    interrupted = True
                    break

                if ttft_ms is None:
                    ttft_ms = int((time.monotonic() - start_mono) * 1000)

                output_chunks += 1
                output_chars += len(token)

                token_event = await asyncio.to_thread(
                    _append_typed_event_db,
                    user_id=user_id,
                    save_id=save_id,
                    frame_type="CHAT_TOKEN",
                    payload={"token": token, "client_request_id": client_request_id},
                    ack_required=True,
                )
                try:
                    await _safe_send_json(token_event)
                except WebSocketDisconnect:
                    interrupted = True
                    break
                except RuntimeError:
                    interrupted = True
                    break

                await asyncio.sleep(0)
            if stop.is_set():
                interrupted = True
        except asyncio.CancelledError:
            interrupted = True
            raise
        except Exception as e:
            error = str(e)
        finally:
            # 先将 DONE 事件落库（用于 resume/replay），但延后发送给客户端：
            # 这样当客户端观察到 CHAT_DONE 时，usage 行已可被查询到（避免 CI/慢机器抖动）。
            done_event = await asyncio.to_thread(
                _append_typed_event_db,
                user_id=user_id,
                save_id=save_id,
                frame_type="CHAT_DONE",
                payload={
                    "interrupted": bool(interrupted),
                    "client_request_id": client_request_id,
                    "error": error,
                },
                ack_required=True,
            )

            ended_at = _utcnow_naive()
            latency_ms = max(0, int((time.monotonic() - start_mono) * 1000))

            labels = LLMChatMetricLabels(
                provider=capture.provider or "unknown",
                api=capture.api or "unknown",
                model=capture.model or "unknown",
            )

            try:
                record_llm_chat_stream(
                    labels=labels,
                    latency_ms=latency_ms,
                    ttft_ms=ttft_ms,
                    output_chunks=output_chunks,
                    output_chars=output_chars,
                    interrupted=bool(interrupted),
                    error=error,
                    prompt_tokens=capture.prompt_tokens,
                    completion_tokens=capture.completion_tokens,
                    total_tokens=capture.total_tokens,
                )
            except Exception:
                pass

            def _persist_usage_row() -> None:
                with SessionLocal() as db:
                    row = LLMUsageEvent(
                        user_id=user_id,
                        save_id=save_id,
                        provider=labels.provider,
                        api=labels.api,
                        model=labels.model,
                        started_at=started_at,
                        ended_at=ended_at,
                        latency_ms=int(latency_ms),
                        time_to_first_token_ms=ttft_ms,
                        output_chunks=int(output_chunks),
                        output_chars=int(output_chars),
                        interrupted=bool(interrupted),
                        error=error,
                        prompt_tokens=capture.prompt_tokens,
                        completion_tokens=capture.completion_tokens,
                        total_tokens=capture.total_tokens,
                    )
                    db.add(row)
                    try:
                        db.commit()
                    except Exception:
                        try:
                            db.rollback()
                        except Exception:
                            pass

            try:
                # 这里必须在发送 CHAT_DONE 之前完成 commit，避免连接关闭触发的任务取消
                # 让 usage 行“偶发不可见/未落库”。
                await asyncio.to_thread(_persist_usage_row)
            except Exception:
                pass

            try:
                await _safe_send_json(done_event)
            except WebSocketDisconnect:
                pass
            except RuntimeError:
                pass

    async def _interrupt_active_stream() -> None:
        nonlocal interrupt_event, stream_task
        if stream_task is None or stream_task.done():
            interrupt_event = None
            stream_task = None
            return

        if interrupt_event is not None:
            interrupt_event.set()

        try:
            await stream_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        finally:
            interrupt_event = None
            stream_task = None

    tail_task = asyncio.create_task(_run_ws_v1_redis_tail())

    async def _cleanup_background_tasks() -> None:
        nonlocal interrupt_event, stream_task, tail_task
        try:
            if interrupt_event is not None:
                interrupt_event.set()
            if stream_task is not None and not stream_task.done():
                _ = stream_task.cancel()
                try:
                    await stream_task
                except BaseException:
                    pass
        except Exception:
            pass

        try:
            if tail_task is not None and not tail_task.done():
                _ = tail_task.cancel()
                try:
                    await tail_task
                except BaseException:
                    pass
        except Exception:
            pass

    try:
        while True:
            raw_obj = cast(object, await websocket.receive_json())
            if not isinstance(raw_obj, dict):
                await websocket.close(code=1003)
                return

            msg = cast(dict[str, object], raw_obj)
            msg_type = msg.get("type")

            if msg_type == "ACK":
                cursor_val = msg.get("cursor")
                if not isinstance(cursor_val, int):
                    cursor_val = msg.get("seq")
                if isinstance(cursor_val, int):
                    _ = await asyncio.to_thread(
                        _ack_device_cursor_and_maybe_trim,
                        user_id=user_id,
                        save_id=save_id,
                        device_id=device_id,
                        cursor=cursor_val,
                    )
                continue

            if msg_type == "PING":
                latest_cursor = await asyncio.to_thread(
                    _get_device_last_acked_seq,
                    user_id=user_id,
                    save_id=save_id,
                    device_id=device_id,
                )
                pong_payload = cast(JSONValue, msg.get("payload"))
                await _safe_send_json(
                    _control_frame(
                        frame_type="PONG",
                        cursor=latest_cursor,
                        payload=pong_payload,
                    )
                )
                continue

            if msg_type == "INTERRUPT":
                if interrupt_event is not None:
                    interrupt_event.set()
                continue

            if msg_type == "CHAT_SEND":
                payload_obj = msg.get("payload")
                if not isinstance(payload_obj, dict):
                    await websocket.close(code=1003)
                    return
                payload = cast(dict[str, object], payload_obj)
                text = payload.get("text")
                if not isinstance(text, str):
                    await websocket.close(code=1003)
                    return

                client_request_id = msg.get("client_request_id")
                if client_request_id is not None and not isinstance(client_request_id, str):
                    await websocket.close(code=1003)
                    return

                # 单连接仅允许一个 stream 在跑；新请求会先中断旧 stream。
                await _interrupt_active_stream()
                interrupt_event = asyncio.Event()
                stream_task = asyncio.create_task(
                    _run_chat_stream(
                        text=text,
                        client_request_id=client_request_id,
                        stop=interrupt_event,
                    )
                )
                continue

            await websocket.close(code=1003)
            return

    except WebSocketDisconnect:
        return
    finally:
        await _cleanup_background_tasks()
