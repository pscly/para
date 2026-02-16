from __future__ import annotations

import base64
import hashlib
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


_V1_PREFIX = "v1:"
_AAD = b"para-admin-secrets-v1"


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(raw: str) -> bytes:
    s = raw.strip()
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def _require_key_32(key: bytes) -> None:
    if len(key) != 32:
        raise ValueError("admin secrets master key must be 32 bytes")


def encrypt_secret(plain: str, *, key: bytes) -> str:
    _require_key_32(key)
    nonce = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(nonce, plain.encode("utf-8"), _AAD)
    return _V1_PREFIX + _b64url_encode(nonce + ct)


def decrypt_secret(enc: str, *, key: bytes) -> str:
    _require_key_32(key)
    if not enc.startswith(_V1_PREFIX):
        raise ValueError("unsupported secret encoding")
    blob = _b64url_decode(enc[len(_V1_PREFIX) :])
    if len(blob) < 13:
        raise ValueError("invalid secret encoding")
    nonce = blob[:12]
    ct = blob[12:]
    plain = AESGCM(key).decrypt(nonce, ct, _AAD)
    return plain.decode("utf-8")


def mask_encrypted_secret(enc: str | None) -> str | None:
    if not enc:
        return None
    fp = hashlib.sha256(enc.encode("utf-8")).hexdigest()[:10]
    return f"enc:{fp}"
