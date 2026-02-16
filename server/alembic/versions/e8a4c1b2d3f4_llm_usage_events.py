"""llm usage events

Revision ID: e8a4c1b2d3f4
Revises: d2e4a7b5c1f0
Create Date: 2026-02-15 00:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "e8a4c1b2d3f4"
down_revision = "d2e4a7b5c1f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    _ = op.create_table(
        "llm_usage_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("save_id", sa.String(length=64), nullable=False),
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("api", sa.String(length=50), nullable=False),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("ended_at", sa.DateTime(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("time_to_first_token_ms", sa.Integer(), nullable=True),
        sa.Column("output_chunks", sa.Integer(), nullable=False),
        sa.Column("output_chars", sa.Integer(), nullable=False),
        sa.Column("interrupted", sa.Boolean(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("latency_ms >= 0", name="ck_llm_usage_events_latency_ms_ge_0"),
        sa.CheckConstraint(
            "time_to_first_token_ms IS NULL OR time_to_first_token_ms >= 0",
            name="ck_llm_usage_events_ttft_ms_ge_0",
        ),
        sa.CheckConstraint("output_chunks >= 0", name="ck_llm_usage_events_output_chunks_ge_0"),
        sa.CheckConstraint("output_chars >= 0", name="ck_llm_usage_events_output_chars_ge_0"),
        sa.CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens >= 0",
            name="ck_llm_usage_events_prompt_tokens_ge_0",
        ),
        sa.CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens >= 0",
            name="ck_llm_usage_events_completion_tokens_ge_0",
        ),
        sa.CheckConstraint(
            "total_tokens IS NULL OR total_tokens >= 0",
            name="ck_llm_usage_events_total_tokens_ge_0",
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_index(op.f("ix_llm_usage_events_user_id"), "llm_usage_events", ["user_id"])
    op.create_index(op.f("ix_llm_usage_events_save_id"), "llm_usage_events", ["save_id"])
    op.create_index(op.f("ix_llm_usage_events_started_at"), "llm_usage_events", ["started_at"])
    op.create_index(op.f("ix_llm_usage_events_ended_at"), "llm_usage_events", ["ended_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_llm_usage_events_ended_at"), table_name="llm_usage_events")
    op.drop_index(op.f("ix_llm_usage_events_started_at"), table_name="llm_usage_events")
    op.drop_index(op.f("ix_llm_usage_events_save_id"), table_name="llm_usage_events")
    op.drop_index(op.f("ix_llm_usage_events_user_id"), table_name="llm_usage_events")
    op.drop_table("llm_usage_events")
