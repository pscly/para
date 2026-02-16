from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "4b8d1a2c3e4f"
down_revision = "9c1f0b2a3d4e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    _ = op.create_table(
        "admin_llm_channels",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=False),
        sa.Column("api_key_enc", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("purpose", sa.String(length=20), nullable=False),
        sa.Column("default_model", sa.String(length=100), nullable=False),
        sa.Column("timeout_ms", sa.Integer(), nullable=False),
        sa.Column("weight", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("purpose IN ('chat','embedding')", name="ck_admin_llm_channels_purpose"),
        sa.CheckConstraint("timeout_ms >= 1", name="ck_admin_llm_channels_timeout_ms_ge_1"),
        sa.CheckConstraint("weight >= 0", name="ck_admin_llm_channels_weight_ge_0"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_admin_llm_channels_name"),
    )

    op.create_index(op.f("ix_admin_llm_channels_name"), "admin_llm_channels", ["name"])
    op.create_index(op.f("ix_admin_llm_channels_enabled"), "admin_llm_channels", ["enabled"])
    op.create_index(op.f("ix_admin_llm_channels_purpose"), "admin_llm_channels", ["purpose"])


def downgrade() -> None:
    op.drop_index(op.f("ix_admin_llm_channels_purpose"), table_name="admin_llm_channels")
    op.drop_index(op.f("ix_admin_llm_channels_enabled"), table_name="admin_llm_channels")
    op.drop_index(op.f("ix_admin_llm_channels_name"), table_name="admin_llm_channels")
    op.drop_table("admin_llm_channels")
