# pyright: reportMissingImports=false
# pyright: reportUnknownParameterType=false
# pyright: reportMissingParameterType=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false

from __future__ import annotations

import uuid
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.base import Base
from app.db.session import engine
from app.main import app
from app.workers.celery_app import celery_app


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


def _install_no_ddl_guard(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    orig_execute = Session.execute

    def guarded_execute(self: Session, statement, *args, **kwargs):  # type: ignore[no-untyped-def]
        sql = str(statement).lower()
        if "create extension" in sql:
            raise AssertionError(f"request/worker path executed DDL: {statement!r}")
        return orig_execute(self, statement, *args, **kwargs)

    monkeypatch.setattr(Session, "execute", guarded_execute, raising=True)


def test_task_1_2_no_request_path_ddl(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    _install_no_ddl_guard(monkeypatch)

    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post("/api/v1/saves", json={"name": "save-no-ddl"}, headers=headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        ingest_resp = client.post(
            "/api/v1/memory/ingest",
            json={"save_id": save_id, "content": "我喜欢蓝色", "source": "test", "trusted": False},
            headers=headers,
        )
        assert ingest_resp.status_code == 201, ingest_resp.text

        search_resp = client.get(
            "/api/v1/memory/search",
            params={"q": "喜欢的颜色", "save_id": save_id, "limit": 5},
            headers=headers,
        )
        assert search_resp.status_code == 200, search_resp.text

        content = (
            """# Notes\n\nThis line is important: PARA_KNOWLEDGE_MAGIC_SENTENCE.\n\nMore text."""
        )
        upload_resp = client.post(
            "/api/v1/knowledge/materials",
            data={"save_id": save_id},
            files={"file": ("note.md", content.encode("utf-8"), "text/markdown")},
            headers=headers,
        )
        assert upload_resp.status_code == 201, upload_resp.text
        upload_body = cast(dict[str, object], upload_resp.json())
        material = cast(dict[str, object], upload_body["material"])
        material_id = cast(str, material["id"])

        status_resp = client.get(f"/api/v1/knowledge/materials/{material_id}", headers=headers)
        assert status_resp.status_code == 200, status_resp.text
        status_body = cast(dict[str, object], status_resp.json())
        assert cast(str, status_body["status"]) == "indexed"

        query_resp = client.post(
            "/api/v1/knowledge/query",
            json={"save_id": save_id, "query": "PARA_KNOWLEDGE_MAGIC_SENTENCE", "top_k": 5},
            headers=headers,
        )
        assert query_resp.status_code == 200, query_resp.text
        query_body = cast(dict[str, object], query_resp.json())
        assert "PARA_KNOWLEDGE_MAGIC_SENTENCE" in cast(str, query_body.get("answer", ""))
