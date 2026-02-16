from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Mapping
from typing import TypeAlias, cast


_PBKDF2_ALG = "pbkdf2_sha256"
_PBKDF2_HASH_NAME = "sha256"
_PBKDF2_ITERATIONS = 200_000
_PBKDF2_SALT_BYTES = 16


JSONScalar: TypeAlias = str | int | float | bool | None
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    if data == "":
        raise ValueError("invalid base64 input")
    padded = data + "=" * ((4 - (len(data) % 4)) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception as exc:
        raise ValueError("invalid base64 input") from exc


def hash_password(password: str) -> str:
    if password == "":
        raise ValueError("password must be a non-empty string")

    salt = secrets.token_bytes(_PBKDF2_SALT_BYTES)
    dk = hashlib.pbkdf2_hmac(
        _PBKDF2_HASH_NAME,
        password.encode("utf-8"),
        salt,
        _PBKDF2_ITERATIONS,
        dklen=32,
    )
    return f"{_PBKDF2_ALG}${_PBKDF2_ITERATIONS}${_b64url_encode(salt)}${_b64url_encode(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        alg, iterations_s, salt_s, hash_s = stored.split("$", 3)
        if alg != _PBKDF2_ALG:
            return False
        iterations = int(iterations_s)
        if iterations <= 0:
            return False
        salt = _b64url_decode(salt_s)
        expected = _b64url_decode(hash_s)
    except Exception:
        return False

    try:
        actual = hashlib.pbkdf2_hmac(
            _PBKDF2_HASH_NAME,
            password.encode("utf-8"),
            salt,
            iterations,
            dklen=len(expected),
        )
    except Exception:
        return False

    return hmac.compare_digest(actual, expected)


def new_refresh_token() -> str:
    return _b64url_encode(secrets.token_bytes(32))


def hash_refresh_token(token: str) -> str:
    if token == "":
        raise ValueError("token must be a non-empty string")
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_password_reset_token() -> str:
    return _b64url_encode(secrets.token_bytes(32))


def hash_password_reset_token(token: str) -> str:
    if token == "":
        raise ValueError("token must be a non-empty string")
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def validate_password_policy(password: str) -> None:
    if password == "":
        raise ValueError("password must be non-empty")
    if any(ch.isspace() for ch in password):
        raise ValueError("password must not contain whitespace")
    has_alpha = any(ch.isalpha() for ch in password)
    has_digit = any(ch.isdigit() for ch in password)
    if not (has_alpha and has_digit):
        raise ValueError("password must contain letters and numbers")


def _json_b64url(obj: Mapping[str, JSONValue]) -> str:
    raw = json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=True).encode("utf-8")
    return _b64url_encode(raw)


def _is_json_value(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, (str, int, float, bool)):
        return True
    if isinstance(value, list):
        raw_list = cast(list[object], value)
        return all(_is_json_value(v) for v in raw_list)
    if isinstance(value, dict):
        raw = cast(dict[object, object], value)
        for k, v in raw.items():
            if not isinstance(k, str):
                return False
            if not _is_json_value(v):
                return False
        return True
    return False


def _json_loads_dict(data: bytes) -> dict[str, JSONValue]:
    try:
        obj = cast(object, json.loads(data.decode("utf-8")))
    except Exception as exc:
        raise ValueError("invalid token") from exc
    if not isinstance(obj, dict):
        raise ValueError("invalid token")
    raw = cast(dict[object, object], obj)
    for k, v in raw.items():
        if not isinstance(k, str):
            raise ValueError("invalid token")
        if not _is_json_value(v):
            raise ValueError("invalid token")
    return cast(dict[str, JSONValue], raw)


def _sign_hs256(message: bytes, secret: str) -> bytes:
    if secret == "":
        raise ValueError("secret must be a non-empty string")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).digest()


def encode_access_token(payload: dict[str, JSONValue], secret: str, expires_in_seconds: int) -> str:
    if expires_in_seconds <= 0:
        raise ValueError("expires_in_seconds must be a positive int")

    now = int(time.time())
    body: dict[str, JSONValue] = dict(payload)
    body["exp"] = now + expires_in_seconds

    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = _json_b64url(header)
    payload_b64 = _json_b64url(body)
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    sig = _sign_hs256(signing_input, secret)
    return f"{header_b64}.{payload_b64}.{_b64url_encode(sig)}"


def decode_access_token(token: str, secret: str) -> dict[str, JSONValue]:
    if token == "":
        raise ValueError("invalid token")

    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("invalid token")
    header_b64, payload_b64, sig_b64 = parts

    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected_sig = _sign_hs256(signing_input, secret)
    try:
        provided_sig = _b64url_decode(sig_b64)
    except ValueError as exc:
        raise ValueError("invalid token") from exc
    if not hmac.compare_digest(provided_sig, expected_sig):
        raise ValueError("invalid token")

    header = _json_loads_dict(_b64url_decode(header_b64))
    payload = _json_loads_dict(_b64url_decode(payload_b64))

    alg = header.get("alg")
    if not isinstance(alg, str) or alg != "HS256":
        raise ValueError("invalid token")

    exp = payload.get("exp")
    if not isinstance(exp, int):
        raise ValueError("invalid token")
    if int(time.time()) >= exp:
        raise ValueError("token expired")

    return payload
