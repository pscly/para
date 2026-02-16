"""auth rate limits

Revision ID: b0d31c0c7a2e
Revises: 7eed360f132d
Create Date: 2026-02-15 00:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "b0d31c0c7a2e"
down_revision = "7eed360f132d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    _ = op.create_table(
        "auth_rate_limits",
        sa.Column("key", sa.String(length=512), nullable=False),
        sa.Column("failures", sa.Integer(), nullable=False),
        sa.Column("reset_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("failures >= 0", name="ck_auth_rate_limits_failures_ge_0"),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_index(
        "ix_auth_rate_limits_reset_at",
        "auth_rate_limits",
        ["reset_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_auth_rate_limits_reset_at", table_name="auth_rate_limits")
    op.drop_table("auth_rate_limits")
