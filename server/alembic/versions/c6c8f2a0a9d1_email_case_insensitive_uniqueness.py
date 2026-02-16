"""email case-insensitive uniqueness

Revision ID: c6c8f2a0a9d1
Revises: b0d31c0c7a2e
Create Date: 2026-02-15 00:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "c6c8f2a0a9d1"
down_revision = "b0d31c0c7a2e"
branch_labels = None
depends_on = None


def _assert_no_lower_email_conflicts(conn: sa.Connection, table: str) -> None:
    rows = conn.execute(
        sa.text(
            f"""
            SELECT lower(email) AS email_norm, COUNT(*) AS c
            FROM {table}
            GROUP BY 1
            HAVING COUNT(*) > 1
            ORDER BY c DESC
            LIMIT 5
            """
        )
    ).fetchall()
    if not rows:
        return

    examples = ", ".join(f"{r[0]}(x{r[1]})" for r in rows)
    raise RuntimeError(
        f"Cannot enforce case-insensitive email uniqueness for {table}: found duplicates when lower(email) is applied: {examples}"
    )


def upgrade() -> None:
    conn = op.get_bind()

    _assert_no_lower_email_conflicts(conn, "users")
    _assert_no_lower_email_conflicts(conn, "admin_users")

    _ = conn.execute(sa.text("UPDATE users SET email = lower(email) WHERE email <> lower(email)"))
    _ = conn.execute(
        sa.text("UPDATE admin_users SET email = lower(email) WHERE email <> lower(email)")
    )

    op.drop_index("ix_users_email", table_name="users")
    op.create_index("ix_users_email", "users", ["email"], unique=False)
    op.execute("CREATE UNIQUE INDEX ux_users_email_lower ON users (lower(email))")

    op.drop_index("ix_admin_users_email", table_name="admin_users")
    op.create_index("ix_admin_users_email", "admin_users", ["email"], unique=False)
    op.execute("CREATE UNIQUE INDEX ux_admin_users_email_lower ON admin_users (lower(email))")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ux_admin_users_email_lower")
    op.drop_index("ix_admin_users_email", table_name="admin_users")
    op.create_index("ix_admin_users_email", "admin_users", ["email"], unique=True)

    op.execute("DROP INDEX IF EXISTS ux_users_email_lower")
    op.drop_index("ix_users_email", table_name="users")
    op.create_index("ix_users_email", "users", ["email"], unique=True)
