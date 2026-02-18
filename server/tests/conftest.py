# pyright: reportUnusedFunction=false
import sys
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def _ensure_test_schema() -> None:
    from sqlalchemy import text

    from app.db.base import Base
    from app.db.session import engine

    with engine.connect() as conn:
        _ = conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()

    Base.metadata.create_all(bind=engine)

    alter_sql = [
        "ALTER TABLE ugc_assets ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP NULL",
        "ALTER TABLE ugc_assets ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(36) NULL",
        "ALTER TABLE ugc_assets ADD COLUMN IF NOT EXISTS review_note TEXT NULL",
        "ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP NULL",
        "ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(36) NULL",
        "ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS review_note TEXT NULL",
        "ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS save_id VARCHAR(36) NULL",
    ]

    with engine.connect() as conn:
        for stmt in alter_sql:
            _ = conn.execute(text(stmt))

        # 与生产迁移保持一致：回填 save_id，并删除已 soft delete 的 memory_items 对应 embedding。
        _ = conn.execute(
            text(
                """
                UPDATE memory_embeddings AS me
                SET save_id = mi.save_id
                FROM memory_items AS mi
                WHERE mi.id = me.memory_id AND me.save_id IS NULL
                """
            )
        )
        _ = conn.execute(
            text(
                """
                DELETE FROM memory_embeddings AS me
                USING memory_items AS mi
                WHERE mi.id = me.memory_id AND mi.deleted_at IS NOT NULL
                """
            )
        )
        _ = conn.execute(text("ALTER TABLE memory_embeddings ALTER COLUMN save_id SET NOT NULL"))
        conn.commit()


_ensure_test_schema()


@pytest.fixture(autouse=True)
def _isolate_db() -> None:
    from app.db.base import Base
    from app.db.session import engine

    tables = list(Base.metadata.sorted_tables)
    if not tables:
        return

    with engine.begin() as conn:
        for t in reversed(tables):
            _ = conn.execute(t.delete())
