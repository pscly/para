"""review fields for ugc + plugin packages

Revision ID: 9c1f0b2a3d4e
Revises: e8a4c1b2d3f4
Create Date: 2026-02-15 00:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "9c1f0b2a3d4e"
down_revision = "e8a4c1b2d3f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ugc_assets", sa.Column("reviewed_at", sa.DateTime(), nullable=True))
    op.add_column("ugc_assets", sa.Column("reviewed_by", sa.String(length=36), nullable=True))
    op.add_column("ugc_assets", sa.Column("review_note", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_ugc_assets_reviewed_by_admin_users",
        "ugc_assets",
        "admin_users",
        ["reviewed_by"],
        ["id"],
        ondelete="SET NULL",
    )

    op.add_column("plugin_packages", sa.Column("reviewed_at", sa.DateTime(), nullable=True))
    op.add_column("plugin_packages", sa.Column("reviewed_by", sa.String(length=36), nullable=True))
    op.add_column("plugin_packages", sa.Column("review_note", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_plugin_packages_reviewed_by_admin_users",
        "plugin_packages",
        "admin_users",
        ["reviewed_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_plugin_packages_reviewed_by_admin_users",
        "plugin_packages",
        type_="foreignkey",
    )
    op.drop_column("plugin_packages", "review_note")
    op.drop_column("plugin_packages", "reviewed_by")
    op.drop_column("plugin_packages", "reviewed_at")

    op.drop_constraint(
        "fk_ugc_assets_reviewed_by_admin_users",
        "ugc_assets",
        type_="foreignkey",
    )
    op.drop_column("ugc_assets", "review_note")
    op.drop_column("ugc_assets", "reviewed_by")
    op.drop_column("ugc_assets", "reviewed_at")
