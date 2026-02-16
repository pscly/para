import sys
from pathlib import Path


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
    ]

    with engine.connect() as conn:
        for stmt in alter_sql:
            _ = conn.execute(text(stmt))
        conn.commit()


_ensure_test_schema()
