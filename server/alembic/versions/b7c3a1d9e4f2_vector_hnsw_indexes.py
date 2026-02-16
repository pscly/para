"""vector hnsw indexes

Revision ID: b7c3a1d9e4f2
Revises: 959e03e01f0b
Create Date: 2026-02-16 00:00:00.000000

"""

from __future__ import annotations

from alembic import op


revision = "b7c3a1d9e4f2"
down_revision = "959e03e01f0b"
branch_labels = None
depends_on = None


_MEM_INDEX = "idx_memory_embeddings_embedding_hnsw_l2"
_KNOW_INDEX = "idx_knowledge_chunks_embedding_hnsw_l2"

_OLD_MEM_INDEX = "ix_memory_embeddings_embedding_hnsw_l2"
_OLD_KNOW_INDEX = "ix_knowledge_chunks_embedding_hnsw_l2"


def _maybe_rename_index(old: str, new: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('{old}') IS NOT NULL
               AND to_regclass('{new}') IS NULL THEN
                EXECUTE 'ALTER INDEX {old} RENAME TO {new}';
            END IF;
        END $$;
        """
    )


def upgrade() -> None:
    _maybe_rename_index(_OLD_MEM_INDEX, _MEM_INDEX)
    _maybe_rename_index(_OLD_KNOW_INDEX, _KNOW_INDEX)

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_memory_embeddings_embedding_hnsw_l2
        ON memory_embeddings
        USING hnsw (embedding vector_l2_ops)
        WITH (m = 16, ef_construction = 64)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw_l2
        ON knowledge_chunks
        USING hnsw (embedding vector_l2_ops)
        WITH (m = 16, ef_construction = 64)
        """
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_MEM_INDEX}")
    op.execute(f"DROP INDEX IF EXISTS {_KNOW_INDEX}")
