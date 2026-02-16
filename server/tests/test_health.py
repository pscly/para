# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false
# pyright: reportPrivateUsage=false

from __future__ import annotations

from typing import cast

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient

from app.main import app
from app.workers.celery_app import celery_app


def test_health_ok(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(celery_app.conf, "task_always_eager", True)
    monkeypatch.setattr(celery_app.conf, "task_eager_propagates", True)

    client = TestClient(app)
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    raw = cast(object, resp.json())
    assert isinstance(raw, dict)
    body = cast(dict[str, object], raw)

    status = body.get("status")
    assert status in {"ok", "degraded"}

    deps_raw = body.get("dependencies")
    assert isinstance(deps_raw, dict)
    deps = cast(dict[str, object], deps_raw)
    assert set(deps.keys()) == {"db", "redis", "pgvector", "worker"}
    for name in ["db", "redis", "pgvector", "worker"]:
        dep_raw = deps.get(name)
        assert isinstance(dep_raw, dict)
        dep = cast(dict[str, object], dep_raw)
        assert dep.get("status") in {"ok", "error"}

    worker_raw = deps["worker"]
    assert isinstance(worker_raw, dict)
    worker = cast(dict[str, object], worker_raw)
    assert worker.get("status") == "ok"
    assert worker.get("mode") == "eager"

    all_ok = True
    for dep_val in deps.values():
        assert isinstance(dep_val, dict)
        if cast(dict[str, object], dep_val).get("status") != "ok":
            all_ok = False
            break
    if all_ok:
        assert status == "ok"
    else:
        assert status == "degraded"
    assert resp.headers.get("X-Request-Id")


def test_check_worker_ok_even_if_timeout_wrapper_broken(monkeypatch: MonkeyPatch) -> None:
    import app.api.v1.health as health

    monkeypatch.setattr(celery_app.conf, "task_always_eager", False)

    def _boom(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("should_not_be_called")

    monkeypatch.setattr(health, "_call_with_timeout", _boom)

    def _fake_ping(*, timeout: float) -> list[dict[str, str]]:
        _ = timeout
        return [{"worker@local": "pong"}]

    monkeypatch.setattr(celery_app.control, "ping", _fake_ping)

    dep = health._check_worker(timeout_s=0.01)
    assert dep.status == "ok"
    assert dep.mode == "remote"
