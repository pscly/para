import os
from typing import cast

import sqlalchemy

from app.core.config import settings
from app.db.session import engine


def _db_uri_safe() -> str:
    try:
        return engine.url.render_as_string(hide_password=True)
    except Exception:
        return str(getattr(engine, "url", "<unknown-url>"))


def _db_uri_source() -> str:
    if settings.database_url or os.getenv("DATABASE_URL"):
        return "DATABASE_URL"
    return "POSTGRES_* (postgres_host/postgres_port/postgres_db/postgres_user)"


def test_db_connection_select_1() -> None:
    try:
        with engine.connect() as conn:
            result = conn.execute(sqlalchemy.text("SELECT 1"))
            value = cast(int, result.scalar_one())
    except Exception as exc:
        msg = "\n".join(
            [
                "无法连接数据库或执行 SELECT 1。",
                f"连接串来源: {_db_uri_source()}",
                f"SQLAlchemy URI(已隐藏密码): {_db_uri_safe()}",
                f"settings: postgres_host={settings.postgres_host} postgres_port={settings.postgres_port} postgres_db={settings.postgres_db} postgres_user={settings.postgres_user}",
                f"异常: {type(exc).__name__}: {exc}",
            ]
        )
        raise AssertionError(msg) from exc

    assert value == 1
