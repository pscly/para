"""ws event store

Revision ID: 7eed360f132d
Revises: f1dcf9f0abe6
Create Date: 2026-02-15 10:10:01.257612

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "7eed360f132d"
down_revision = "f1dcf9f0abe6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    _ = op.create_table(
        "ws_streams",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("save_id", sa.String(length=64), nullable=False),
        sa.Column("next_seq", sa.Integer(), nullable=False),
        sa.Column("trimmed_upto_seq", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("next_seq >= 1", name="ck_ws_streams_next_seq_ge_1"),
        sa.CheckConstraint("trimmed_upto_seq >= 0", name="ck_ws_streams_trimmed_upto_seq_ge_0"),
        sa.PrimaryKeyConstraint("user_id", "save_id"),
    )

    _ = op.create_table(
        "ws_device_cursors",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("save_id", sa.String(length=64), nullable=False),
        sa.Column("device_id", sa.String(length=100), nullable=False),
        sa.Column("last_acked_seq", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("last_acked_seq >= 0", name="ck_ws_device_cursors_last_acked_seq_ge_0"),
        sa.PrimaryKeyConstraint("user_id", "save_id", "device_id"),
    )

    _ = op.create_table(
        "ws_events",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("save_id", sa.String(length=64), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("frame_type", sa.String(length=50), nullable=False),
        sa.Column("payload_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("ack_required", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("seq >= 1", name="ck_ws_events_seq_ge_1"),
        sa.PrimaryKeyConstraint("user_id", "save_id", "seq"),
    )


def downgrade() -> None:
    op.drop_table("ws_events")
    op.drop_table("ws_device_cursors")
    op.drop_table("ws_streams")
