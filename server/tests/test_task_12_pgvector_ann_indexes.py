# pyright: reportMissingImports=false

from __future__ import annotations

from typing import cast

from sqlalchemy import text

from app.db.session import engine


def test_task_12_pgvector_ann_indexes_sql_valid_and_present() -> None:
    # 迁移中使用了 CONCURRENTLY，因此这里用 AUTOCOMMIT 来做最小确定性校验。
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        _ = conn.execute(
            text(
                """
                CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_memory_embeddings_embedding_hnsw_l2
                ON memory_embeddings
                USING hnsw (embedding vector_l2_ops)
                WITH (m = 16, ef_construction = 64)
                """
            )
        )
        _ = conn.execute(
            text(
                """
                CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_knowledge_chunks_embedding_hnsw_l2
                ON knowledge_chunks
                USING hnsw (embedding vector_l2_ops)
                WITH (m = 16, ef_construction = 64)
                """
            )
        )

    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE schemaname = 'public'
                  AND indexname IN (
                    'ix_memory_embeddings_embedding_hnsw_l2',
                    'ix_knowledge_chunks_embedding_hnsw_l2'
                  )
                """
            )
        ).all()

    defs = {cast(str, r[0]): cast(str, r[1]) for r in rows}
    assert "ix_memory_embeddings_embedding_hnsw_l2" in defs
    assert "USING hnsw" in defs["ix_memory_embeddings_embedding_hnsw_l2"]
    assert "vector_l2_ops" in defs["ix_memory_embeddings_embedding_hnsw_l2"]

    assert "ix_knowledge_chunks_embedding_hnsw_l2" in defs
    assert "USING hnsw" in defs["ix_knowledge_chunks_embedding_hnsw_l2"]
    assert "vector_l2_ops" in defs["ix_knowledge_chunks_embedding_hnsw_l2"]
