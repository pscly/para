# pyright: reportMissingImports=false
# pyright: reportUnknownParameterType=false
# pyright: reportMissingParameterType=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false

from __future__ import annotations

import base64
import json
import secrets
import time
import uuid
from typing import cast

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


TokenPair = dict[str, str]


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(raw: str) -> bytes:
    s = raw.strip()
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def _aad_req(*, kid: str, ts: int, rid: str, method: str, path: str, query: str) -> bytes:
    aad = (
        "para-appenc-v1\n"
        f"typ=req\n"
        f"kid={kid}\n"
        f"ts={ts}\n"
        f"rid={rid}\n"
        f"method={method}\n"
        f"path={path}\n"
        f"query={query}"
    )
    return aad.encode("utf-8")


def _aad_resp(*, kid: str, ts: int, rid: str, status: int) -> bytes:
    aad = f"para-appenc-v1\ntyp=resp\nkid={kid}\nts={ts}\nrid={rid}\nstatus={status}"
    return aad.encode("utf-8")


def _random_email() -> str:
    return f"test-{uuid.uuid4().hex}@example.com"


def _register(client: TestClient, *, email: str, password: str) -> TokenPair:
    resp = client.post("/api/v1/auth/register", json={"email": email, "password": password})
    assert resp.status_code == 201, resp.text
    data = cast(TokenPair, resp.json())
    assert "access_token" in data
    assert "refresh_token" in data
    return data


def _make_settings(keys: dict[str, bytes]) -> Settings:
    return Settings(
        para_appenc_enabled=True,
        para_appenc_keys=keys,
        para_appenc_ts_window_sec=120,
    )


def _encrypt_req(
    *,
    key: bytes,
    kid: str,
    rid: str,
    ts: int,
    method: str,
    path: str,
    query: str,
    payload_obj: dict[str, object],
) -> dict[str, object]:
    plain = json.dumps(payload_obj, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    nonce = secrets.token_bytes(12)
    aad = _aad_req(kid=kid, ts=ts, rid=rid, method=method, path=path, query=query)
    ct = AESGCM(key).encrypt(nonce, plain, aad)
    return {
        "v": 1,
        "typ": "req",
        "alg": "A256GCM",
        "kid": kid,
        "ts": ts,
        "rid": rid,
        "nonce": _b64url_encode(nonce),
        "ct": _b64url_encode(ct),
    }


def _decrypt_resp(
    *,
    key: bytes,
    expected_kid: str,
    expected_rid: str,
    env: dict[str, object],
    status: int,
) -> dict[str, object]:
    assert env.get("v") == 1
    assert env.get("typ") == "resp"
    assert env.get("alg") == "A256GCM"
    assert env.get("kid") == expected_kid
    assert env.get("rid") == expected_rid
    ts = env.get("ts")
    assert isinstance(ts, int)

    nonce_raw = cast(str, env.get("nonce"))
    ct_raw = cast(str, env.get("ct"))
    nonce = _b64url_decode(nonce_raw)
    ct = _b64url_decode(ct_raw)
    aad = _aad_resp(kid=expected_kid, ts=ts, rid=expected_rid, status=status)
    plain = AESGCM(key).decrypt(nonce, ct, aad)
    decoded_obj: object = cast(object, json.loads(plain))
    assert isinstance(decoded_obj, dict)
    return cast(dict[str, object], decoded_obj)


def test_task_19_appenc_login_encrypt_req_and_resp() -> None:
    key = b"d" * 32
    keys = {"k1": key}
    app = create_app(_make_settings(keys))

    with TestClient(app) as client:
        email = _random_email()
        _ = _register(client, email=email, password="password123")

        rid = _b64url_encode(secrets.token_bytes(16))
        ts = int(time.time())
        env = _encrypt_req(
            key=key,
            kid="k1",
            rid=rid,
            ts=ts,
            method="POST",
            path="/api/v1/auth/login",
            query="",
            payload_obj={"email": email, "password": "password123"},
        )

        resp = client.post(
            "/api/v1/auth/login",
            headers={
                "Content-Type": "application/json",
                "X-Para-Enc": "v1",
                "X-Para-Enc-Resp": "v1",
            },
            content=json.dumps(env, ensure_ascii=True, separators=(",", ":")),
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers.get("X-Para-Enc") == "v1"
        raw = cast(object, resp.json())
        assert isinstance(raw, dict)
        env_resp = cast(dict[str, object], raw)

        body = _decrypt_resp(
            key=key,
            expected_kid="k1",
            expected_rid=rid,
            env=env_resp,
            status=200,
        )
        assert isinstance(body.get("access_token"), str)
        assert isinstance(body.get("refresh_token"), str)
