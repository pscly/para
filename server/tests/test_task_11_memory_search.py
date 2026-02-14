# pyright: reportMissingImports=false

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.base import Base
from app.db.session import engine
from app.main import app


def _ensure_pgvector_and_create_all() -> None:
    with engine.connect() as conn:
        _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()
    Base.metadata.create_all(bind=engine)


_ensure_pgvector_and_create_all()


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


def test_task_11_memory_ingest_search_delete_writes_evidence() -> None:
    email = _random_email()
    password = "password123"

    with TestClient(app) as client:
        tokens = _register(client, email=email, password=password)
        access = tokens["access_token"]
        headers = {"Authorization": f"Bearer {access}"}

        save_resp = client.post("/api/v1/saves", json={"name": "save-mem"}, headers=headers)
        assert save_resp.status_code == 201, save_resp.text
        save_id = cast(str, cast(dict[str, object], save_resp.json())["id"])

        ingest_resp = client.post(
            "/api/v1/memory/ingest",
            json={
                "save_id": save_id,
                "content": "我喜欢蓝色",
                "source": "test",
                "trusted": False,
            },
            headers=headers,
        )
        assert ingest_resp.status_code == 201, ingest_resp.text
        ingest_body = cast(dict[str, object], ingest_resp.json())
        memory_id = cast(str, ingest_body["id"])

        search_resp = client.get(
            "/api/v1/memory/search",
            params={"q": "喜欢的颜色", "save_id": save_id, "limit": 5},
            headers=headers,
        )
        assert search_resp.status_code == 200, search_resp.text
        search_body = cast(list[dict[str, object]], search_resp.json())
        assert len(search_body) >= 1
        assert cast(str, search_body[0]["id"]) == memory_id

        del_resp = client.delete(
            f"/api/v1/memory/{memory_id}",
            params={"save_id": save_id},
            headers=headers,
        )
        assert del_resp.status_code == 200, del_resp.text
        del_body = cast(dict[str, object], del_resp.json())
        assert cast(str, del_body["id"]) == memory_id

        search2_resp = client.get(
            "/api/v1/memory/search",
            params={"q": "喜欢的颜色", "save_id": save_id, "limit": 5},
            headers=headers,
        )
        assert search2_resp.status_code == 200, search2_resp.text
        search2_body = cast(list[dict[str, object]], search2_resp.json())
        assert all(cast(str, it["id"]) != memory_id for it in search2_body)

        repo_root = Path(__file__).resolve().parents[2]
        evidence_path = repo_root / ".sisyphus" / "evidence" / "task-11-memory-search.json"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)

        evidence = {
            "task": 11,
            "save_id": save_id,
            "memory_id": memory_id,
            "ingest": ingest_body,
            "search_before_delete": search_body,
            "delete": del_body,
            "search_after_delete": search2_body,
        }
        _ = evidence_path.write_text(
            json.dumps(evidence, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )
