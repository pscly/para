from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import hashlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AuthRateLimit


def _now_utc() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _safe_key(raw: str) -> str:
    if len(raw) <= 512:
        return raw
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return f"auth|sha256:{digest}"


def _ip_key(ip: str | None) -> str:
    if not isinstance(ip, str) or ip.strip() == "":
        return "unknown"
    return ip.strip()


def auth_rate_limit_key(*, scope: str, ip: str | None, identifier: str | None = None) -> str:
    ident = ""
    if isinstance(identifier, str) and identifier.strip() != "":
        ident = identifier.strip().lower()
    raw = f"{scope}|{_ip_key(ip)}|{ident}"
    return _safe_key(raw)


@dataclass(frozen=True)
class RateLimitCheck:
    blocked: bool
    retry_after_seconds: int


class AuthRateLimiter:
    def __init__(self, *, enabled: bool, max_failures: int, window_seconds: int):
        self._enabled: bool = bool(enabled)
        self._max_failures: int = int(max_failures)
        self._window_seconds: int = int(window_seconds)

    def check(self, db: Session, *, key: str) -> RateLimitCheck:
        if not self._enabled:
            return RateLimitCheck(blocked=False, retry_after_seconds=0)
        if self._max_failures <= 0 or self._window_seconds <= 0:
            return RateLimitCheck(blocked=False, retry_after_seconds=0)

        now = _now_utc()
        row = db.get(AuthRateLimit, key)
        if row is None:
            return RateLimitCheck(blocked=False, retry_after_seconds=0)
        if row.reset_at <= now:
            return RateLimitCheck(blocked=False, retry_after_seconds=0)
        if row.failures < self._max_failures:
            return RateLimitCheck(blocked=False, retry_after_seconds=0)
        retry_after = int((row.reset_at - now).total_seconds())
        if retry_after < 0:
            retry_after = 0
        return RateLimitCheck(blocked=True, retry_after_seconds=retry_after)

    def record_failure(self, db: Session, *, key: str) -> None:
        if not self._enabled:
            return
        if self._max_failures <= 0 or self._window_seconds <= 0:
            return

        now = _now_utc()
        reset_at = now + timedelta(seconds=self._window_seconds)

        row = (
            db.execute(select(AuthRateLimit).where(AuthRateLimit.key == key).with_for_update())
            .scalars()
            .one_or_none()
        )
        if row is None:
            row = AuthRateLimit(key=key, failures=1, reset_at=reset_at)
            db.add(row)
        else:
            if row.reset_at <= now:
                row.failures = 1
                row.reset_at = reset_at
            else:
                row.failures = int(row.failures) + 1
        db.commit()

    def reset(self, db: Session, *, key: str) -> None:
        if not self._enabled:
            return
        row = db.get(AuthRateLimit, key)
        if row is None:
            return
        db.delete(row)
        db.flush()
