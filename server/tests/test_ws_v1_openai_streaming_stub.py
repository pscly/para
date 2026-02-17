# pyright: reportMissingImports=false

from __future__ import annotations

import json
import socket
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast, override

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.testclient import WebSocketTestSession

from app.core.admin_secrets import encrypt_secret
from app.core.config import settings
from app.db.base import Base
from app.db.models import AdminKV, AdminLLMChannel
from app.db.session import engine
from app.db.session import SessionLocal
from app.main import app


with engine.connect() as conn:
    _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    conn.commit()
Base.metadata.create_all(bind=engine)


TokenPair = dict[str, str]


def _random_email() -> str:
    return f"test-{uuid.uuid4().hex}@example.com"


def _register(client: TestClient, email: str, password: str) -> TokenPair:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 201, resp.text
    data = cast(TokenPair, resp.json())
    assert "access_token" in data
    assert "refresh_token" in data
    return data


def _get_user_id(client: TestClient, access_token: str) -> str:
    me = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert me.status_code == 200, me.text
    body = cast(dict[str, str], me.json())
    user_id = body["user_id"]
    assert isinstance(user_id, str)
    assert user_id
    return user_id


def _create_save_id(client: TestClient, *, headers: dict[str, str], name: str) -> str:
    r = client.post("/api/v1/saves", json={"name": name}, headers=headers)
    assert r.status_code == 201, r.text
    data = cast(dict[str, object], r.json())
    save_id = data.get("id")
    assert isinstance(save_id, str) and save_id
    return save_id


def _recv_json_dict(ws: WebSocketTestSession) -> dict[str, object]:
    raw = cast(object, ws.receive_json())
    assert isinstance(raw, dict), f"expected dict json frame, got: {type(raw)!r}"
    return cast(dict[str, object], raw)


def _recv_until_type(
    ws: WebSocketTestSession,
    expected_type: str,
    *,
    max_frames: int = 500,
) -> dict[str, object]:
    for _ in range(max_frames):
        msg = _recv_json_dict(ws)
        if msg.get("type") == expected_type:
            return msg
    raise AssertionError(f"did not receive type={expected_type!r} within {max_frames} frames")


def _assert_is_event_frame(msg: dict[str, object]) -> None:
    server_event_id = msg.get("server_event_id")
    assert isinstance(server_event_id, str)
    assert server_event_id

    seq = msg.get("seq")
    assert isinstance(seq, int)
    assert seq >= 1


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        sockname = cast(tuple[str, int], s.getsockname())
        return sockname[1]
    finally:
        s.close()


class _StubOpenAIHandler(BaseHTTPRequestHandler):
    protocol_version: str = "HTTP/1.1"

    expected_authorization: str | None = None
    expected_model: str | None = None
    last_authorization: str | None = None
    last_model: str | None = None

    @override
    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return

    def _read_json_body(self) -> dict[str, object]:
        length_raw = self.headers.get("Content-Length")
        length = int(length_raw) if length_raw else 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            obj = cast(object, json.loads(raw.decode("utf-8")))
        except Exception:
            return {}
        if not isinstance(obj, dict):
            return {}
        out: dict[str, object] = {}
        raw_dict = cast(dict[object, object], obj)
        for k, v in raw_dict.items():
            if isinstance(k, str):
                out[k] = v
        return out

    def do_POST(self) -> None:  # noqa: N802
        _StubOpenAIHandler.last_authorization = self.headers.get("Authorization")
        body = self._read_json_body()
        model_obj = body.get("model")
        _StubOpenAIHandler.last_model = model_obj if isinstance(model_obj, str) else None

        if (
            _StubOpenAIHandler.expected_authorization is not None
            and _StubOpenAIHandler.last_authorization != _StubOpenAIHandler.expected_authorization
        ):
            self.send_response(401)
            self.end_headers()
            return

        if (
            _StubOpenAIHandler.expected_model is not None
            and _StubOpenAIHandler.last_model != _StubOpenAIHandler.expected_model
        ):
            self.send_response(400)
            self.end_headers()
            return

        if self.path in ("/v1/responses", "/responses"):
            if not body.get("stream"):
                self.send_response(400)
                self.end_headers()
                return
            self._stream_responses_sse()
            return

        if self.path in ("/v1/chat/completions", "/chat/completions"):
            if not body.get("stream"):
                self.send_response(400)
                self.end_headers()
                return
            self._stream_chat_completions_sse()
            return

        self.send_response(404)
        self.end_headers()

    def _start_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

    def _send_sse_data(self, data: str) -> bool:
        try:
            payload = f"data: {data}\n\n".encode("utf-8")
            _ = self.wfile.write(payload)
            self.wfile.flush()
            return True
        except BrokenPipeError:
            return False
        except ConnectionResetError:
            return False

    def _stream_responses_sse(self) -> None:
        self._start_sse()

        for _ in range(200):
            ev = {"type": "response.output_text.delta", "delta": "x"}
            ok = self._send_sse_data(json.dumps(ev))
            if not ok:
                return
            time.sleep(0.002)

        _ = self._send_sse_data("[DONE]")

    def _stream_chat_completions_sse(self) -> None:
        self._start_sse()

        for _ in range(200):
            ev = {"choices": [{"delta": {"content": "x"}}]}
            ok = self._send_sse_data(json.dumps(ev))
            if not ok:
                return
            time.sleep(0.002)

        _ = self._send_sse_data("[DONE]")


class _StubServer:
    base_url: str
    _httpd: ThreadingHTTPServer
    _t: threading.Thread

    def __init__(self) -> None:
        port = _free_port()
        self.base_url = f"http://127.0.0.1:{port}"
        self._httpd = ThreadingHTTPServer(("127.0.0.1", port), _StubOpenAIHandler)
        self._t = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self) -> "_StubServer":
        self._t.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._t.join(timeout=2)


@contextmanager
def _admin_chat_channel_routing(
    *, base_url: str, api_key: str, model: str, timeout_ms: int = 60000
) -> Iterator[str]:
    with SessionLocal() as db:
        old_kv = (
            db.query(AdminKV)
            .filter(AdminKV.namespace == "llm_routing", AdminKV.key == "global")
            .one_or_none()
        )
        old_value_json = old_kv.value_json if old_kv is not None else None

        now_key = settings.admin_secrets_master_key_bytes
        row = AdminLLMChannel(
            name=f"stub-chat-{uuid.uuid4().hex}",
            base_url=base_url,
            api_key_enc=encrypt_secret(api_key, key=now_key),
            enabled=True,
            purpose="chat",
            default_model=model,
            timeout_ms=int(timeout_ms),
            weight=100,
        )
        db.add(row)
        db.flush()
        channel_id = row.id

        obj = {
            "default_chat_channel_id": channel_id,
            "default_embedding_channel_id": None,
        }

        if old_kv is None:
            db.add(AdminKV(namespace="llm_routing", key="global", value_json=json.dumps(obj)))
        else:
            old_kv.value_json = json.dumps(obj)

        db.commit()

    try:
        yield channel_id
    finally:
        with SessionLocal() as db2:
            try:
                ch = db2.get(AdminLLMChannel, channel_id)
                if ch is not None:
                    db2.delete(ch)

                kv2 = (
                    db2.query(AdminKV)
                    .filter(AdminKV.namespace == "llm_routing", AdminKV.key == "global")
                    .one_or_none()
                )

                if old_value_json is None:
                    if kv2 is not None:
                        db2.delete(kv2)
                else:
                    if kv2 is None:
                        db2.add(
                            AdminKV(
                                namespace="llm_routing",
                                key="global",
                                value_json=old_value_json,
                            )
                        )
                    else:
                        kv2.value_json = old_value_json

                db2.commit()
            except Exception:
                db2.rollback()
                raise


@pytest.mark.parametrize("api", ["responses", "chat_completions"])
def test_ws_v1_openai_streaming_stub_emits_tokens_then_done(
    monkeypatch: pytest.MonkeyPatch, api: str
) -> None:
    with _StubServer() as stub:
        with _admin_chat_channel_routing(
            base_url=stub.base_url,
            api_key="channel-key",
            model="channel-model",
        ):
            _StubOpenAIHandler.expected_authorization = "Bearer channel-key"
            _StubOpenAIHandler.expected_model = "channel-model"
            _StubOpenAIHandler.last_authorization = None
            _StubOpenAIHandler.last_model = None

            monkeypatch.setenv("OPENAI_MODE", "openai")
            monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1")
            monkeypatch.setenv("OPENAI_API_KEY", "env-key")
            monkeypatch.setenv("OPENAI_MODEL", "env-model")
            monkeypatch.setenv("OPENAI_API", api)

            email = _random_email()
            password = "password123"
            client_request_id = str(uuid.uuid4())

            with TestClient(app) as client:
                tokens = _register(client, email=email, password=password)
                access = tokens["access_token"]

                user_id = _get_user_id(client, access_token=access)
                assert user_id

                headers = {"Authorization": f"Bearer {access}"}
                save_id = _create_save_id(
                    client, headers=headers, name=f"save-chat-{uuid.uuid4().hex}"
                )
                url = f"/ws/v1?save_id={save_id}&resume_from=0"
                with client.websocket_connect(url, headers=headers) as ws:
                    _ = _recv_until_type(ws, "HELLO")

                    ws.send_json(
                        {
                            "type": "CHAT_SEND",
                            "payload": {"text": "hello"},
                            "client_request_id": client_request_id,
                        }
                    )

                    got_token = False
                    got_done = False
                    for _ in range(20_000):
                        msg = _recv_json_dict(ws)
                        msg_type = msg.get("type")

                        if msg_type == "CHAT_TOKEN":
                            _assert_is_event_frame(msg)
                            got_token = True
                            continue

                        if msg_type == "CHAT_DONE":
                            _assert_is_event_frame(msg)
                            payload = msg.get("payload")
                            assert isinstance(payload, dict)
                            payload_dict = cast(dict[str, object], payload)
                            assert payload_dict.get("client_request_id") == client_request_id
                            assert payload_dict.get("interrupted") is False
                            got_done = True
                            break

                    assert got_token, "expected at least one CHAT_TOKEN frame"
                    assert got_done, "expected final CHAT_DONE frame"

            assert _StubOpenAIHandler.last_authorization == "Bearer channel-key"
            assert _StubOpenAIHandler.last_model == "channel-model"


def test_ws_v1_openai_streaming_stub_interrupt_sets_done_interrupted_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _StubServer() as stub:
        with _admin_chat_channel_routing(
            base_url=stub.base_url,
            api_key="channel-key",
            model="channel-model",
        ):
            _StubOpenAIHandler.expected_authorization = "Bearer channel-key"
            _StubOpenAIHandler.expected_model = "channel-model"
            _StubOpenAIHandler.last_authorization = None
            _StubOpenAIHandler.last_model = None

            monkeypatch.setenv("OPENAI_MODE", "openai")
            monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1")
            monkeypatch.setenv("OPENAI_API_KEY", "env-key")
            monkeypatch.setenv("OPENAI_MODEL", "env-model")
            monkeypatch.setenv("OPENAI_API", "responses")

            email = _random_email()
            password = "password123"
            client_request_id = str(uuid.uuid4())

            with TestClient(app) as client:
                tokens = _register(client, email=email, password=password)
                access = tokens["access_token"]
                user_id = _get_user_id(client, access_token=access)
                assert user_id

                headers = {"Authorization": f"Bearer {access}"}
                save_id = _create_save_id(
                    client, headers=headers, name=f"save-chat-{uuid.uuid4().hex}"
                )
                url = f"/ws/v1?save_id={save_id}&resume_from=0"
                with client.websocket_connect(url, headers=headers) as ws:
                    _ = _recv_until_type(ws, "HELLO")

                    ws.send_json(
                        {
                            "type": "CHAT_SEND",
                            "payload": {"text": "hello"},
                            "client_request_id": client_request_id,
                        }
                    )

                    while True:
                        msg = _recv_json_dict(ws)
                        msg_type = msg.get("type")
                        if msg_type == "CHAT_TOKEN":
                            _assert_is_event_frame(msg)
                            break
                        if msg_type == "CHAT_DONE":
                            raise AssertionError("received CHAT_DONE before first CHAT_TOKEN")

                    ws.send_json({"type": "INTERRUPT"})

                    done = _recv_until_type(ws, "CHAT_DONE", max_frames=20_000)
                    _assert_is_event_frame(done)
                    payload = done.get("payload")
                    assert isinstance(payload, dict)
                    payload_dict = cast(dict[str, object], payload)
                    assert payload_dict.get("client_request_id") == client_request_id
                    assert payload_dict.get("interrupted") is True

            assert _StubOpenAIHandler.last_authorization == "Bearer channel-key"
            assert _StubOpenAIHandler.last_model == "channel-model"
