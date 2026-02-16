# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false

from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.workers.celery_app import celery_app


def _with_celery_eager() -> tuple[bool, bool]:
    prev_always_eager = bool(getattr(celery_app.conf, "task_always_eager", False))
    prev_eager_propagates = bool(getattr(celery_app.conf, "task_eager_propagates", False))
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    return prev_always_eager, prev_eager_propagates


def _restore_celery_eager(prev: tuple[bool, bool]) -> None:
    celery_app.conf.task_always_eager = prev[0]
    celery_app.conf.task_eager_propagates = prev[1]


def test_task_5_3_security_headers_present() -> None:
    prev = _with_celery_eager()
    try:
        app = create_app(Settings())
        client = TestClient(app)
        resp = client.get("/api/v1/health")
        assert resp.status_code == 200

        assert resp.headers.get("X-Request-Id")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"
        assert resp.headers.get("X-Frame-Options") == "DENY"
        assert resp.headers.get("Referrer-Policy")
        assert resp.headers.get("Permissions-Policy")
    finally:
        _restore_celery_eager(prev)


def test_task_5_3_cors_allowlist_only() -> None:
    prev = _with_celery_eager()
    try:
        allowed_origin = "https://admin.example"
        s = Settings.model_validate({"cors_allowed_origins": f'["{allowed_origin}"]'})
        assert s.cors_allowed_origins == [allowed_origin]
        app = create_app(s)
        client = TestClient(app)

        ok = client.get("/api/v1/health", headers={"Origin": allowed_origin})
        assert ok.status_code == 200
        assert ok.headers.get("access-control-allow-origin") == allowed_origin

        bad = client.get("/api/v1/health", headers={"Origin": "https://evil.example"})
        assert bad.status_code == 200
        assert "access-control-allow-origin" not in bad.headers

        preflight_ok = client.options(
            "/api/v1/health",
            headers={
                "Origin": allowed_origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Authorization",
            },
        )
        assert preflight_ok.status_code == 200
        assert preflight_ok.headers.get("access-control-allow-origin") == allowed_origin

        preflight_bad = client.options(
            "/api/v1/health",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Authorization",
            },
        )
        assert preflight_bad.status_code == 400
        assert "access-control-allow-origin" not in preflight_bad.headers
    finally:
        _restore_celery_eager(prev)


def test_task_5_3_trusted_host_enforced() -> None:
    prev = _with_celery_eager()
    try:
        app = create_app(Settings(trusted_hosts=["admin.example"]))

        ok_client = TestClient(app, base_url="http://admin.example")
        ok = ok_client.get("/api/v1/health")
        assert ok.status_code == 200

        bad_client = TestClient(app, base_url="http://evil.example")
        bad = bad_client.get("/api/v1/health")
        assert bad.status_code == 400
        assert bad.headers.get("X-Request-Id")
        assert bad.headers.get("X-Content-Type-Options") == "nosniff"
    finally:
        _restore_celery_eager(prev)
