from __future__ import annotations

import asyncio
import base64
import json
import secrets
import time
from typing import cast

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import Settings


_PROTO_LINE = "para-appenc-v1"
_ALG = "A256GCM"


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(raw: str) -> bytes:
    s = raw.strip()
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def _is_json_content_type(ct: str | None) -> bool:
    if not ct:
        return False
    base = ct.split(";", 1)[0].strip().lower()
    return base == "application/json"


def _aad_request(*, kid: str, ts: int, rid: str, method: str, path: str, query: str) -> bytes:
    aad = (
        f"{_PROTO_LINE}\n"
        f"typ=req\n"
        f"kid={kid}\n"
        f"ts={ts}\n"
        f"rid={rid}\n"
        f"method={method}\n"
        f"path={path}\n"
        f"query={query}"
    )
    return aad.encode("utf-8")


def _aad_response(*, kid: str, ts: int, rid: str, status: int) -> bytes:
    aad = f"{_PROTO_LINE}\ntyp=resp\nkid={kid}\nts={ts}\nrid={rid}\nstatus={status}"
    return aad.encode("utf-8")


def _get_header(scope: Scope, name_lc: bytes) -> str | None:
    for k, v in cast(list[tuple[bytes, bytes]], scope.get("headers", [])):
        if k.lower() == name_lc:
            try:
                return v.decode("latin-1")
            except Exception:
                return None
    return None


def _json_response_messages(
    *, status: int, obj: object, extra_headers: list[tuple[bytes, bytes]] | None = None
) -> list[Message]:
    body = json.dumps(obj, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    headers: list[tuple[bytes, bytes]] = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("ascii")),
    ]
    if extra_headers:
        headers.extend(extra_headers)
    return [
        {"type": "http.response.start", "status": status, "headers": headers},
        {"type": "http.response.body", "body": body, "more_body": False},
    ]


class _ReplayCache:
    def __init__(self, *, ttl_sec: int) -> None:
        self._ttl_sec: int = max(1, int(ttl_sec))
        self._lock: asyncio.Lock = asyncio.Lock()
        self._seen: dict[tuple[str, str], float] = {}

    async def check_and_store(self, *, kid: str, rid: str, now: float) -> bool:
        key = (kid, rid)
        async with self._lock:
            if self._seen:
                expired: list[tuple[str, str]] = []
                for k, exp in self._seen.items():
                    if exp <= now:
                        expired.append(k)
                for k in expired:
                    _ = self._seen.pop(k, None)

            exp = self._seen.get(key)
            if exp is not None and exp > now:
                return True

            self._seen[key] = now + self._ttl_sec
            return False


class AppEncryptionMiddleware:
    def __init__(self, app: ASGIApp, *, settings: Settings) -> None:
        self.app: ASGIApp = app
        self._settings: Settings = settings
        self._replay: _ReplayCache = _ReplayCache(ttl_sec=settings.para_appenc_ts_window_sec)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        enc = _get_header(scope, b"x-para-enc")
        if enc != "v1":
            await self.app(scope, receive, send)
            return

        if not _is_json_content_type(_get_header(scope, b"content-type")):
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_UNSUPPORTED_CONTENT_TYPE"}
            ):
                await send(msg)
            return

        chunks: list[bytes] = []
        while True:
            msg: Message = await receive()
            if msg.get("type") != "http.request":
                continue
            body_raw = cast(object, msg.get("body", b""))
            body_part = bytes(body_raw) if isinstance(body_raw, (bytes, bytearray)) else b""
            if body_part:
                chunks.append(body_part)
            more_body_raw = cast(object, msg.get("more_body", False))
            more_body = more_body_raw is True
            if not more_body:
                break
        raw_body = b"".join(chunks)
        if raw_body == b"":
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_EMPTY_BODY"}
            ):
                await send(msg)
            return

        try:
            env_obj: object = cast(object, json.loads(raw_body))
        except Exception:
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_BAD_ENVELOPE"}
            ):
                await send(msg)
            return
        if not isinstance(env_obj, dict):
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_BAD_ENVELOPE"}
            ):
                await send(msg)
            return

        env = cast(dict[str, object], env_obj)

        if env.get("v") != 1 or env.get("typ") != "req" or env.get("alg") != _ALG:
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_BAD_ENVELOPE"}
            ):
                await send(msg)
            return

        kid = env.get("kid")
        ts = env.get("ts")
        rid = env.get("rid")
        nonce = env.get("nonce")
        ct = env.get("ct")
        if not (
            isinstance(kid, str)
            and isinstance(ts, int)
            and isinstance(rid, str)
            and isinstance(nonce, str)
            and isinstance(ct, str)
        ):
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_BAD_ENVELOPE"}
            ):
                await send(msg)
            return

        key = self._settings.para_appenc_keys.get(kid)
        if not key:
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_UNKNOWN_KID"}
            ):
                await send(msg)
            return

        try:
            rid_bytes = _b64url_decode(rid)
            nonce_bytes = _b64url_decode(nonce)
            ct_bytes = _b64url_decode(ct)
        except Exception:
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_BAD_ENVELOPE"}
            ):
                await send(msg)
            return

        if len(rid_bytes) != 16 or len(nonce_bytes) != 12 or len(ct_bytes) < 16:
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_BAD_ENVELOPE"}
            ):
                await send(msg)
            return

        now = int(time.time())
        if abs(now - ts) > int(self._settings.para_appenc_ts_window_sec):
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_TS_OUT_OF_WINDOW"}
            ):
                await send(msg)
            return

        if await self._replay.check_and_store(kid=kid, rid=rid, now=float(now)):
            for msg in _json_response_messages(status=409, obj={"detail": "PARA_APPENC_REPLAY"}):
                await send(msg)
            return

        raw_query = cast(bytes, scope.get("query_string", b""))
        query = raw_query.decode("latin-1")
        method = cast(str, scope.get("method", ""))
        path = cast(str, scope.get("path", ""))

        aad = _aad_request(kid=kid, ts=ts, rid=rid, method=method, path=path, query=query)
        try:
            plain = AESGCM(key).decrypt(nonce_bytes, ct_bytes, aad)
        except Exception:
            for msg in _json_response_messages(
                status=400, obj={"detail": "PARA_APPENC_DECRYPT_FAILED"}
            ):
                await send(msg)
            return

        want_resp_enc = _get_header(scope, b"x-para-enc-resp") == "v1"

        sent_plain = False

        async def receive_plain() -> Message:
            nonlocal sent_plain
            if sent_plain:
                return {"type": "http.request", "body": b"", "more_body": False}
            sent_plain = True
            return {"type": "http.request", "body": plain, "more_body": False}

        if not want_resp_enc:
            await self.app(scope, receive_plain, send)
            return

        start_msg: Message | None = None
        body_chunks: list[bytes] = []
        saw_more_body = False
        passthrough = False
        start_sent = False

        async def send_wrapper(message: Message) -> None:
            nonlocal start_msg, body_chunks, saw_more_body, passthrough, start_sent

            mtype = message.get("type")
            if mtype == "http.response.start":
                start_msg = message
                return

            if mtype != "http.response.body":
                await send(message)
                return

            if start_msg is None:
                await send(message)
                return

            status = cast(int, start_msg.get("status", 200))
            headers = cast(list[tuple[bytes, bytes]], start_msg.get("headers", []))
            content_type: str | None = None
            for k, v in headers:
                if k.lower() == b"content-type":
                    try:
                        content_type = v.decode("latin-1")
                    except Exception:
                        content_type = None
                    break

            if not _is_json_content_type(content_type):
                if not start_sent:
                    start_sent = True
                    await send(start_msg)
                await send(message)
                passthrough = True
                return

            body_raw = cast(object, message.get("body", b""))
            body_part = bytes(body_raw) if isinstance(body_raw, (bytes, bytearray)) else b""
            if body_part:
                body_chunks.append(body_part)
            more_body_raw = cast(object, message.get("more_body", False))
            if more_body_raw is True:
                saw_more_body = True

            if saw_more_body:
                if not passthrough:
                    passthrough = True
                    if not start_sent:
                        start_sent = True
                        await send(start_msg)
                    for ch in body_chunks:
                        await send({"type": "http.response.body", "body": ch, "more_body": True})
                    body_chunks = []
                await send(message)
                return

            plain_resp = b"".join(body_chunks)
            body_chunks = []

            primary_kid = self._settings.para_appenc_primary_kid
            if not primary_kid:
                if not start_sent:
                    start_sent = True
                    await send(start_msg)
                await send({"type": "http.response.body", "body": plain_resp, "more_body": False})
                return
            primary_key = self._settings.para_appenc_keys.get(primary_kid)
            if not primary_key:
                if not start_sent:
                    start_sent = True
                    await send(start_msg)
                await send({"type": "http.response.body", "body": plain_resp, "more_body": False})
                return

            resp_ts = int(time.time())
            resp_nonce = secrets.token_bytes(12)
            resp_aad = _aad_response(kid=primary_kid, ts=resp_ts, rid=rid, status=status)
            ct_out = AESGCM(primary_key).encrypt(resp_nonce, plain_resp, resp_aad)
            out_env = {
                "v": 1,
                "typ": "resp",
                "alg": _ALG,
                "kid": primary_kid,
                "ts": resp_ts,
                "rid": rid,
                "nonce": _b64url_encode(resp_nonce),
                "ct": _b64url_encode(ct_out),
            }

            encrypted = json.dumps(out_env, ensure_ascii=True, separators=(",", ":")).encode(
                "utf-8"
            )
            new_headers: list[tuple[bytes, bytes]] = []
            for k, v in headers:
                lk = k.lower()
                if lk in (b"content-length", b"content-type", b"x-para-enc"):
                    continue
                new_headers.append((k, v))
            new_headers.append((b"content-type", b"application/json"))
            new_headers.append((b"x-para-enc", b"v1"))
            new_headers.append((b"content-length", str(len(encrypted)).encode("ascii")))

            await send({"type": "http.response.start", "status": status, "headers": new_headers})
            await send({"type": "http.response.body", "body": encrypted, "more_body": False})

        await self.app(scope, receive_plain, send_wrapper)
