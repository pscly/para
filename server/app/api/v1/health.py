from __future__ import annotations

# pyright: reportMissingTypeStubs=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnusedFunction=false

import os
import socket
import ssl
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Literal, TypeVar, cast
from urllib.parse import urlparse

from celery import Celery
import psycopg
from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.core.config import settings
from app.workers.celery_app import celery_app

router = APIRouter(tags=["health"])


class DependencyStatus(BaseModel):
    status: Literal["ok", "error"]
    latency_ms: int | None = None
    detail: str | None = Field(default=None, description="简短排障信息（不包含敏感信息）")
    mode: str | None = Field(default=None, description="worker 模式：eager/remote")


class HealthDependencies(BaseModel):
    db: DependencyStatus
    redis: DependencyStatus
    pgvector: DependencyStatus
    worker: DependencyStatus


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"] = Field(
        description="整体健康状态；必须与 dependencies 的状态一致"
    )
    dependencies: HealthDependencies


_DEFAULT_TIMEOUT_S = 0.5


def _safe_exc_detail(exc: Exception) -> str:
    return type(exc).__name__


def _sqlalchemy_url_to_psycopg_dsn(sqlalchemy_uri: str) -> str:
    if sqlalchemy_uri.startswith("postgresql+psycopg://"):
        return "postgresql://" + sqlalchemy_uri.removeprefix("postgresql+psycopg://")
    return sqlalchemy_uri


def _check_db_and_pgvector(*, timeout_s: float) -> tuple[DependencyStatus, DependencyStatus]:
    start = time.perf_counter()
    dsn = _sqlalchemy_url_to_psycopg_dsn(settings.sqlalchemy_database_uri)
    statement_timeout_ms = max(50, int(timeout_s * 1000))
    connect_timeout_s: int = max(1, int(timeout_s))

    try:
        with psycopg.connect(
            dsn,
            connect_timeout=connect_timeout_s,
            options=f"-c statement_timeout={statement_timeout_ms}",
        ) as conn:
            with conn.cursor() as cur:
                _ = cur.execute("SELECT 1")
                _ = cur.fetchone()
                db_latency_ms = int((time.perf_counter() - start) * 1000)
                db = DependencyStatus(status="ok", latency_ms=db_latency_ms)

                pg_start = time.perf_counter()
                _ = cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
                row = cur.fetchone()
                pg_latency_ms = int((time.perf_counter() - pg_start) * 1000)
                if row is not None:
                    return db, DependencyStatus(status="ok", latency_ms=pg_latency_ms)
                return db, DependencyStatus(
                    status="error", latency_ms=pg_latency_ms, detail="extension_missing"
                )
    except Exception as exc:
        latency_ms = int((time.perf_counter() - start) * 1000)
        db = DependencyStatus(status="error", latency_ms=latency_ms, detail=_safe_exc_detail(exc))
        pgvector = DependencyStatus(status="error", detail="db_unavailable")
        return db, pgvector


def _resp_encode_command(*parts: str) -> bytes:
    out = [f"*{len(parts)}\r\n".encode("utf-8")]
    for p in parts:
        b = p.encode("utf-8")
        out.append(f"${len(b)}\r\n".encode("utf-8"))
        out.append(b)
        out.append(b"\r\n")
    return b"".join(out)


def _check_redis(*, timeout_s: float) -> DependencyStatus:
    start = time.perf_counter()

    broker_url = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    parsed = urlparse(broker_url)
    if parsed.scheme not in {"redis", "rediss"}:
        return DependencyStatus(
            status="error", detail=f"unsupported_scheme:{parsed.scheme or '<none>'}"
        )

    host = parsed.hostname or "localhost"
    port = parsed.port or 6379
    username = parsed.username
    password = parsed.password
    use_tls = parsed.scheme == "rediss"

    try:
        with socket.create_connection((host, port), timeout=timeout_s) as raw_sock:
            raw_sock.settimeout(timeout_s)

            sock: socket.socket
            if use_tls:
                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(raw_sock, server_hostname=host)
                sock.settimeout(timeout_s)
            else:
                sock = raw_sock

            with sock.makefile("rwb", buffering=0) as f:
                if password is not None:
                    if username is not None:
                        _ = f.write(_resp_encode_command("AUTH", username, password))
                    else:
                        _ = f.write(_resp_encode_command("AUTH", password))
                    line = f.readline(1024)
                    if not line.startswith(b"+OK"):
                        latency_ms = int((time.perf_counter() - start) * 1000)
                        return DependencyStatus(
                            status="error", latency_ms=latency_ms, detail="auth_failed"
                        )

                _ = f.write(_resp_encode_command("PING"))
                line = f.readline(1024)
                if line.startswith(b"+PONG") or line.startswith(b"+OK"):
                    latency_ms = int((time.perf_counter() - start) * 1000)
                    return DependencyStatus(status="ok", latency_ms=latency_ms)

                latency_ms = int((time.perf_counter() - start) * 1000)
                if line.startswith(b"-"):
                    return DependencyStatus(
                        status="error", latency_ms=latency_ms, detail="redis_error"
                    )
                return DependencyStatus(
                    status="error", latency_ms=latency_ms, detail="unexpected_response"
                )
    except Exception as exc:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return DependencyStatus(status="error", latency_ms=latency_ms, detail=_safe_exc_detail(exc))


T = TypeVar("T")


def _call_with_timeout(fn: Callable[[], T], *, timeout_s: float) -> T:
    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(fn)
        return fut.result(timeout=timeout_s)


def _check_worker(*, timeout_s: float) -> DependencyStatus:
    celery: Celery = celery_app
    if bool(getattr(celery.conf, "task_always_eager", False)):
        return DependencyStatus(status="ok", mode="eager")

    start = time.perf_counter()
    try:
        replies_obj = celery.control.ping(timeout=timeout_s)
        replies = cast(list[dict[str, str]] | None, replies_obj)
    except Exception as exc:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return DependencyStatus(
            status="error",
            latency_ms=latency_ms,
            mode="remote",
            detail=_safe_exc_detail(exc),
        )

    latency_ms = int((time.perf_counter() - start) * 1000)
    if replies:
        return DependencyStatus(status="ok", latency_ms=latency_ms, mode="remote")
    return DependencyStatus(
        status="error", latency_ms=latency_ms, mode="remote", detail="no_workers"
    )


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    timeout_s = float(os.getenv("HEALTH_TIMEOUT_S", str(_DEFAULT_TIMEOUT_S)))

    db, pgvector = _check_db_and_pgvector(timeout_s=timeout_s)
    redis = _check_redis(timeout_s=timeout_s)
    worker = _check_worker(timeout_s=timeout_s)

    dependencies = HealthDependencies(db=db, redis=redis, pgvector=pgvector, worker=worker)
    overall_ok = all(
        d.status == "ok"
        for d in [dependencies.db, dependencies.redis, dependencies.pgvector, dependencies.worker]
    )
    status: Literal["ok", "degraded"] = "ok" if overall_ok else "degraded"
    return HealthResponse(status=status, dependencies=dependencies)
