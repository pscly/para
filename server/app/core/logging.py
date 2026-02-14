from __future__ import annotations

import contextvars
import logging
import re
import sys
from typing import override


request_id_ctx_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class RequestIdFilter(logging.Filter):
    @override
    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        record.request_id = request_id_ctx_var.get()
        return True


_RE_BEARER = re.compile(
    r"(?i)(authorization\s*[:=]\s*bearer\s+)([a-z0-9._~+/=-]+)",
)

# 注意：不要按通用字段名 token 做脱敏（例如 WS 的 CHAT_TOKEN），仅匹配明确的敏感字段/模式。
_RE_JSON_OAUTH_TOKENS = re.compile(
    r'(?:(?:"access_token"|"refresh_token")\s*:\s*"([^"]+)")',
    re.IGNORECASE,
)
_RE_PY_OAUTH_TOKENS = re.compile(
    r"(?:'access_token'|'refresh_token')\s*:\s*'([^']+)'",
    re.IGNORECASE,
)
_RE_KV_OAUTH_TOKENS = re.compile(
    r"(?i)\b(access_token|refresh_token)\b\s*=\s*([^\s,;]+)",
)

_RE_JSON_AUTH_BEARER = re.compile(
    r'(?i)("authorization"\s*:\s*")\s*(bearer\s+)([^\"]+)(")',
)
_RE_PY_AUTH_BEARER = re.compile(
    r"(?i)('authorization'\s*:\s*')\s*(bearer\s+)([^']+)(')",
)
_RE_IMAGE_B64_JSON = re.compile(r'("image_base64"\s*:\s*")([^"]+)(")', re.IGNORECASE)
_RE_IMAGE_B64_PY = re.compile(r"('image_base64'\s*:\s*')([^']+)(')", re.IGNORECASE)
_RE_IMAGE_B64_KV = re.compile(r"(?i)\b(image_base64)\b\s*=\s*(['\"]?)([^'\"\s,;]+)\2")
_RE_CODE_JSON = re.compile(r'("code"\s*:\s*")([^"]+)(")', re.IGNORECASE)
_RE_CODE_PY = re.compile(r"('code'\s*:\s*')([^']+)(')", re.IGNORECASE)
_RE_MANIFEST_JSON = re.compile(r'("manifest_json"\s*:\s*")([^"]+)(")', re.IGNORECASE)
_RE_DATA_URL = re.compile(
    r"(?i)(data:image\/[a-z0-9.+-]+;base64,)([a-z0-9+/=]+)",
)
_RE_LONG_B64 = re.compile(r"(?<![a-f0-9])[A-Za-z0-9+/]{120,}={0,2}")


def _redact_value(raw: str) -> str:
    return f"[REDACTED len={len(raw)}]"


class RedactingFormatter(logging.Formatter):
    @override
    def format(self, record: logging.LogRecord) -> str:
        out = super().format(record)

        out = _RE_BEARER.sub(r"\1[REDACTED]", out)

        out = _RE_JSON_AUTH_BEARER.sub(
            lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]{m.group(4)}", out
        )
        out = _RE_PY_AUTH_BEARER.sub(
            lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]{m.group(4)}", out
        )

        out = _RE_JSON_OAUTH_TOKENS.sub(
            lambda m: m.group(0).replace(m.group(1), _redact_value(m.group(1))), out
        )
        out = _RE_PY_OAUTH_TOKENS.sub(
            lambda m: m.group(0).replace(m.group(1), _redact_value(m.group(1))), out
        )

        out = _RE_KV_OAUTH_TOKENS.sub(lambda m: f"{m.group(1)}={_redact_value(m.group(2))}", out)

        out = _RE_IMAGE_B64_JSON.sub(
            lambda m: f"{m.group(1)}{_redact_value(m.group(2))}{m.group(3)}", out
        )
        out = _RE_IMAGE_B64_PY.sub(
            lambda m: f"{m.group(1)}{_redact_value(m.group(2))}{m.group(3)}", out
        )
        out = _RE_IMAGE_B64_KV.sub(lambda m: f"{m.group(1)}={_redact_value(m.group(3))}", out)

        out = _RE_CODE_JSON.sub(
            lambda m: f"{m.group(1)}{_redact_value(m.group(2))}{m.group(3)}", out
        )
        out = _RE_CODE_PY.sub(lambda m: f"{m.group(1)}{_redact_value(m.group(2))}{m.group(3)}", out)
        out = _RE_MANIFEST_JSON.sub(
            lambda m: f"{m.group(1)}{_redact_value(m.group(2))}{m.group(3)}", out
        )

        out = _RE_DATA_URL.sub(lambda m: f"{m.group(1)}{_redact_value(m.group(2))}", out)
        out = _RE_LONG_B64.sub("[REDACTED_B64]", out)

        return out


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.setLevel(level)

    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RequestIdFilter())
    handler.setFormatter(
        RedactingFormatter(
            fmt="%(asctime)s %(levelname)s [%(name)s] [rid=%(request_id)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )

    # Avoid duplicate handlers when app reloads in dev.
    root.handlers = [handler]
