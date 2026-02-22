"""debug_allowed

Revision ID: 7904ac92bb9f
Revises: 2d6a1098897f
Create Date: 2026-02-21 21:43:35.926891

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "7904ac92bb9f"
down_revision = "2d6a1098897f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "debug_allowed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "debug_allowed")
