from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from typing import Protocol, TypedDict, cast

import redis
import redis.asyncio as redis_async


class _AsyncPubSub(Protocol):
    async def subscribe(self, *args: object, **kwargs: object) -> object: ...

    async def unsubscribe(self, *args: object, **kwargs: object) -> object: ...

    async def close(self) -> object: ...

    def listen(self) -> AsyncIterator[object]: ...


class WsV1AppendNotify(TypedDict, total=True):
    user_id: str
    save_id: str
    seq: int


def _redis_url() -> str:
    # 复用 Celery 的 broker 作为默认 Redis；允许专门覆盖 WS。
    return os.getenv("WS_REDIS_URL") or os.getenv("CELERY_BROKER_URL") or "redis://localhost:6379/0"


def ws_v1_stream_channel(*, user_id: str, save_id: str) -> str:
    # 精确路由到单个 stream；每个 WS 连接只订阅自己的 channel。
    return f"ws:v1:{user_id}:{save_id}"


def encode_ws_v1_append_notify(*, user_id: str, save_id: str, seq: int) -> str:
    payload: WsV1AppendNotify = {"user_id": user_id, "save_id": save_id, "seq": int(seq)}
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=True)


def decode_ws_v1_append_notify(data: object) -> WsV1AppendNotify | None:
    if isinstance(data, bytes):
        try:
            data = data.decode("utf-8")
        except Exception:
            return None

    if not isinstance(data, str) or data.strip() == "":
        return None

    try:
        obj = cast(object, json.loads(data))
    except Exception:
        return None

    if not isinstance(obj, dict):
        return None
    user_id = obj.get("user_id")
    save_id = obj.get("save_id")
    seq = obj.get("seq")
    if not isinstance(user_id, str) or user_id == "":
        return None
    if not isinstance(save_id, str) or save_id == "":
        return None
    if not isinstance(seq, int) or seq < 1:
        return None
    return {"user_id": user_id, "save_id": save_id, "seq": int(seq)}


_sync_client: redis.Redis | None = None


def get_sync_redis() -> redis.Redis:
    global _sync_client
    if _sync_client is None:
        _sync_client = redis.Redis.from_url(
            _redis_url(),
            decode_responses=True,
            socket_connect_timeout=1.0,
            socket_timeout=1.0,
            health_check_interval=30,
        )
    return _sync_client


def get_async_redis() -> redis_async.Redis:
    # 不做全局 singleton：async client/pool 的生命周期更难控，按连接创建更直观。
    return redis_async.Redis.from_url(
        _redis_url(),
        decode_responses=True,
        socket_connect_timeout=1.0,
        socket_timeout=1.0,
        health_check_interval=30,
    )


def publish_ws_v1_append_notify(*, user_id: str, save_id: str, seq: int) -> None:
    channel = ws_v1_stream_channel(user_id=user_id, save_id=save_id)
    payload = encode_ws_v1_append_notify(user_id=user_id, save_id=save_id, seq=seq)
    r = get_sync_redis()
    # 返回值是订阅者数量；目前不依赖。
    _ = r.publish(channel, payload)


async def subscribe_ws_v1_stream(
    *, user_id: str, save_id: str
) -> tuple[redis_async.Redis, _AsyncPubSub, str]:
    r = get_async_redis()
    channel = ws_v1_stream_channel(user_id=user_id, save_id=save_id)
    pubsub_raw = r.pubsub(ignore_subscribe_messages=True)
    pubsub = cast(_AsyncPubSub, cast(object, pubsub_raw))
    _ = await pubsub.subscribe(channel)
    return r, pubsub, channel


async def close_async_redis_pubsub(
    *, r: redis_async.Redis, pubsub: _AsyncPubSub, channel: str
) -> None:
    try:
        _ = await pubsub.unsubscribe(channel)
    except Exception:
        pass
    try:
        _ = await pubsub.close()
    except Exception:
        pass

    try:
        await r.close()  # type: ignore[func-returns-value]
    except Exception:
        try:
            await r.aclose()  # type: ignore[attr-defined]
        except Exception:
            pass
    try:
        await r.connection_pool.disconnect()  # type: ignore[func-returns-value]
    except Exception:
        pass
