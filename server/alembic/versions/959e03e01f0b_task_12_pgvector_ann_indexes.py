"""task_12_pgvector_ann_indexes

Revision ID: 959e03e01f0b
Revises: 4b8d1a2c3e4f
Create Date: 2026-02-16 19:09:42.568907

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "959e03e01f0b"
down_revision = "4b8d1a2c3e4f"
branch_labels = None
depends_on = None


_MEM_HNSW_INDEX = "ix_memory_embeddings_embedding_hnsw_l2"
_KNOW_HNSW_INDEX = "ix_knowledge_chunks_embedding_hnsw_l2"


def _create_ann_indexes() -> None:
    # CONCURRENTLY 避免长时间阻塞写入（生产数据量下更安全）。
    # 注意：CONCURRENTLY 不能在事务内执行，因此需要 autocommit_block。
    with op.get_context().autocommit_block():
        op.execute(
            """
            CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_memory_embeddings_embedding_hnsw_l2
            ON memory_embeddings
            USING hnsw (embedding vector_l2_ops)
            WITH (m = 16, ef_construction = 64)
            """
        )
        op.execute(
            """
            CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_knowledge_chunks_embedding_hnsw_l2
            ON knowledge_chunks
            USING hnsw (embedding vector_l2_ops)
            WITH (m = 16, ef_construction = 64)
            """
        )


def _drop_ann_indexes() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {_MEM_HNSW_INDEX}")
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {_KNOW_HNSW_INDEX}")


def upgrade() -> None:
    # pgvector 类型与 HNSW/IVFFLAT 索引依赖 extension。
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # 为 memory_embeddings 冗余 save_id，便于按 save_id 过滤并让 KNN 查询更容易走 ANN 索引。
    op.add_column(
        "memory_embeddings",
        sa.Column("save_id", sa.String(length=36), nullable=True),
    )

    # 回填 save_id；并清理已 soft delete 的 memory_items 对应 embedding（避免后续检索误入）。
    op.execute(
        """
        UPDATE memory_embeddings AS me
        SET save_id = mi.save_id
        FROM memory_items AS mi
        WHERE mi.id = me.memory_id AND me.save_id IS NULL
        """
    )
    op.execute(
        """
        DELETE FROM memory_embeddings AS me
        USING memory_items AS mi
        WHERE mi.id = me.memory_id AND mi.deleted_at IS NOT NULL
        """
    )

    op.alter_column(
        "memory_embeddings", "save_id", existing_type=sa.String(length=36), nullable=False
    )
    op.create_index("ix_memory_embeddings_save_id", "memory_embeddings", ["save_id"], unique=False)

    _create_ann_indexes()


def downgrade() -> None:
    _drop_ann_indexes()

    op.drop_index("ix_memory_embeddings_save_id", table_name="memory_embeddings")
    op.drop_column("memory_embeddings", "save_id")
