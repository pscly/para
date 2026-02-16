# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUntypedFunctionDecorator=false

from __future__ import annotations

from datetime import datetime, timezone
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import KnowledgeChunk, MemoryEmbedding, MemoryItem
from app.db.session import engine
from app.services.embedding_provider import embed_text
from app.workers.celery_app import celery_app


def _clamp_limit(limit: int, *, default: int = 200, max_limit: int = 2000) -> int:
    try:
        n = int(limit)
    except Exception:
        return default
    if n <= 0:
        return default
    return min(n, max_limit)


@celery_app.task(name="app.workers.tasks.embeddings.task_11_reembed_memory_embeddings")
def task_11_reembed_memory_embeddings(
    *,
    start_after_memory_id: str | None = None,
    limit: int = 200,
    force: bool = False,
) -> dict[str, object]:
    batch = _clamp_limit(limit)

    stmt = (
        select(MemoryEmbedding, MemoryItem.content)
        .join(MemoryItem, MemoryItem.id == MemoryEmbedding.memory_id)
        .order_by(MemoryEmbedding.memory_id.asc())
    )
    if start_after_memory_id:
        stmt = stmt.where(MemoryEmbedding.memory_id > start_after_memory_id)
    stmt = stmt.limit(batch)

    processed = 0
    updated = 0
    skipped = 0
    last_id: str | None = None
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    with Session(engine) as db:
        rows = cast(list[tuple[MemoryEmbedding, str]], db.execute(stmt).tuples().all())
        for row, content in rows:
            processed += 1
            last_id = row.memory_id
            emb = embed_text(content, db=db)
            if (
                (not force)
                and row.embedding_model == emb.embedding_model
                and int(row.embedding_dim) == int(emb.embedding_dim)
            ):
                skipped += 1
                continue
            row.embedding_model = emb.embedding_model
            row.embedding_dim = int(emb.embedding_dim)
            row.embedding = emb.embedding
            updated += 1

        db.commit()

    return {
        "ok": True,
        "processed": processed,
        "updated": updated,
        "skipped": skipped,
        "batch_limit": batch,
        "start_after_memory_id": start_after_memory_id,
        "next_start_after_memory_id": last_id,
        "as_of": now.isoformat() + "Z",
    }


@celery_app.task(name="app.workers.tasks.embeddings.task_11_reembed_knowledge_chunks")
def task_11_reembed_knowledge_chunks(
    *,
    start_after_chunk_id: str | None = None,
    limit: int = 200,
    force: bool = False,
) -> dict[str, object]:
    batch = _clamp_limit(limit)

    stmt = select(KnowledgeChunk).order_by(KnowledgeChunk.id.asc())
    if start_after_chunk_id:
        stmt = stmt.where(KnowledgeChunk.id > start_after_chunk_id)
    stmt = stmt.limit(batch)

    processed = 0
    updated = 0
    skipped = 0
    last_id: str | None = None
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    with Session(engine) as db:
        chunks = cast(list[KnowledgeChunk], db.execute(stmt).scalars().all())
        for ch in chunks:
            processed += 1
            last_id = ch.id
            emb = embed_text(ch.content, db=db)
            if (
                (not force)
                and ch.embedding_model == emb.embedding_model
                and int(ch.embedding_dim) == int(emb.embedding_dim)
            ):
                skipped += 1
                continue
            ch.embedding_model = emb.embedding_model
            ch.embedding_dim = int(emb.embedding_dim)
            ch.embedding = emb.embedding
            updated += 1

        db.commit()

    return {
        "ok": True,
        "processed": processed,
        "updated": updated,
        "skipped": skipped,
        "batch_limit": batch,
        "start_after_chunk_id": start_after_chunk_id,
        "next_start_after_chunk_id": last_id,
        "as_of": now.isoformat() + "Z",
    }
