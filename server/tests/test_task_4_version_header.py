from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.version import get_app_version
from app.main import app


def test_task_4_all_http_responses_have_para_version_header() -> None:
    client = TestClient(app)
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200

    expected = get_app_version()
    assert app.version == expected
    assert resp.headers.get("X-Para-Version") == expected
