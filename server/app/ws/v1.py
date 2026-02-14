from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field
from typing import TypeAlias, TypedDict, cast

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from app.core.config import settings
from app.core.security import JSONValue, decode_access_token
from app.ws.chat_fake import fake_chat_tokens


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


@dataclass
class StreamState:
    next_seq: int = 1
    events: dict[int, WSFrame] = field(default_factory=dict)
    last_acked_seq: int = 0


_streams_lock = threading.Lock()
_streams: dict[StreamKey, StreamState] = {}


def _get_or_create_stream_state(stream_key: StreamKey) -> StreamState:
    with _streams_lock:
        state = _streams.get(stream_key)
        if state is None:
            state = StreamState()
            _streams[stream_key] = state
        return state


def _append_typed_event(
    stream_key: StreamKey,
    *,
    frame_type: str,
    payload: JSONValue,
    ack_required: bool = True,
) -> WSFrame:
    user_id, save_id = stream_key
    with _streams_lock:
        state = _streams.get(stream_key)
        if state is None:
            state = StreamState()
            _streams[stream_key] = state

        seq = state.next_seq
        state.next_seq += 1

        event: WSFrame = {
            "protocol_version": PROTOCOL_VERSION,
            "type": str(frame_type),
            "seq": seq,
            "cursor": seq,
            "server_event_id": f"{user_id}:{save_id}:{seq}",
            "ack_required": bool(ack_required),
            "payload": payload,
        }
        state.events[seq] = event
        return event


def append_event(stream_key: StreamKey, payload: JSONValue, ack_required: bool = True) -> WSFrame:
    return _append_typed_event(
        stream_key, frame_type="EVENT", payload=payload, ack_required=ack_required
    )


def append_typed_event(
    stream_key: StreamKey,
    *,
    frame_type: str,
    payload: JSONValue,
    ack_required: bool = True,
) -> WSFrame:
    return _append_typed_event(
        stream_key, frame_type=frame_type, payload=payload, ack_required=ack_required
    )


def get_events_after(stream_key: StreamKey, resume_from: int) -> list[WSFrame]:
    if resume_from < 0:
        return []

    with _streams_lock:
        state = _streams.get(stream_key)
        if state is None:
            return []
        seqs = [s for s in state.events.keys() if s > resume_from]
        seqs.sort()
        return [state.events[s] for s in seqs]


def _update_last_acked_seq(stream_key: StreamKey, cursor: int) -> None:
    if cursor < 0:
        return

    with _streams_lock:
        state = _streams.get(stream_key)
        if state is None:
            state = StreamState()
            _streams[stream_key] = state

        max_seq_in_log = state.next_seq - 1
        bounded = min(cursor, max_seq_in_log)
        state.last_acked_seq = max(state.last_acked_seq, bounded)


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


router = APIRouter()


@router.websocket("/ws/v1")
async def ws_v1(websocket: WebSocket) -> None:
    save_id = websocket.query_params.get("save_id")
    resume_from_raw = websocket.query_params.get("resume_from")
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

    stream_key: StreamKey = (user_id, save_id)
    state = _get_or_create_stream_state(stream_key)

    await websocket.accept()

    send_lock = asyncio.Lock()
    interrupt_event: asyncio.Event | None = None
    stream_task: asyncio.Task[None] | None = None

    await websocket.send_json(
        _control_frame(
            frame_type="HELLO",
            cursor=state.last_acked_seq,
            payload={"user_id": user_id, "save_id": save_id},
        )
    )

    for event in get_events_after(stream_key, resume_from=resume_from):
        await websocket.send_json(event)

    async def _safe_send_json(frame: WSFrame) -> None:
        async with send_lock:
            await websocket.send_json(frame)

    async def _run_fake_chat_stream(
        *, text: str, client_request_id: str | None, stop: asyncio.Event
    ) -> None:
        interrupted = False
        try:
            async for token in fake_chat_tokens(text):
                if stop.is_set():
                    interrupted = True
                    break

                token_event = _append_typed_event(
                    stream_key,
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
        except asyncio.CancelledError:
            interrupted = True
            raise
        finally:
            done_event = _append_typed_event(
                stream_key,
                frame_type="CHAT_DONE",
                payload={
                    "interrupted": bool(interrupted),
                    "client_request_id": client_request_id,
                },
                ack_required=True,
            )
            try:
                await _safe_send_json(done_event)
            except WebSocketDisconnect:
                return
            except RuntimeError:
                return

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
                    _update_last_acked_seq(stream_key, cursor=cursor_val)
                continue

            if msg_type == "PING":
                latest = _get_or_create_stream_state(stream_key)
                pong_payload = cast(JSONValue, msg.get("payload"))
                await _safe_send_json(
                    _control_frame(
                        frame_type="PONG",
                        cursor=latest.last_acked_seq,
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
                    _run_fake_chat_stream(
                        text=text,
                        client_request_id=client_request_id,
                        stop=interrupt_event,
                    )
                )
                continue

            await websocket.close(code=1003)
            return

    except WebSocketDisconnect:
        try:
            if interrupt_event is not None:
                interrupt_event.set()
            if stream_task is not None and not stream_task.done():
                _ = stream_task.cancel()
                try:
                    await stream_task
                except Exception:
                    pass
        except Exception:
            pass
        return
