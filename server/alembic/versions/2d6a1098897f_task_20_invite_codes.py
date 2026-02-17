"""task_20_invite_codes

Revision ID: 2d6a1098897f
Revises: b7c3a1d9e4f2
Create Date: 2026-02-17 00:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "2d6a1098897f"
down_revision = "b7c3a1d9e4f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    _ = op.create_table(
        "invite_codes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("code_prefix", sa.String(length=12), nullable=False),
        sa.Column("max_uses", sa.Integer(), nullable=False),
        sa.Column("uses_count", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_admin_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("max_uses >= 1", name="ck_invite_codes_max_uses_ge_1"),
        sa.CheckConstraint("uses_count >= 0", name="ck_invite_codes_uses_count_ge_0"),
        sa.CheckConstraint(
            "uses_count <= max_uses",
            name="ck_invite_codes_uses_count_le_max_uses",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_admin_id"],
            ["admin_users.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code_hash", name="uq_invite_codes_code_hash"),
    )

    op.create_index(op.f("ix_invite_codes_code_hash"), "invite_codes", ["code_hash"])
    op.create_index(op.f("ix_invite_codes_code_prefix"), "invite_codes", ["code_prefix"])
    op.create_index(op.f("ix_invite_codes_revoked_at"), "invite_codes", ["revoked_at"])

    _ = op.create_table(
        "invite_redemptions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("invite_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("user_email", sa.String(length=320), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["invite_id"], ["invite_codes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "invite_id",
            "user_id",
            name="uq_invite_redemptions_invite_user",
        ),
    )

    op.create_index(
        op.f("ix_invite_redemptions_invite_id"),
        "invite_redemptions",
        ["invite_id"],
    )
    op.create_index(
        op.f("ix_invite_redemptions_user_id"),
        "invite_redemptions",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_invite_redemptions_user_id"), table_name="invite_redemptions")
    op.drop_index(op.f("ix_invite_redemptions_invite_id"), table_name="invite_redemptions")
    op.drop_table("invite_redemptions")

    op.drop_index(op.f("ix_invite_codes_revoked_at"), table_name="invite_codes")
    op.drop_index(op.f("ix_invite_codes_code_prefix"), table_name="invite_codes")
    op.drop_index(op.f("ix_invite_codes_code_hash"), table_name="invite_codes")
    op.drop_table("invite_codes")
