"""users username

Revision ID: 8f35e9f1a5a2
Revises: 7904ac92bb9f
Create Date: 2026-02-22 14:45:59.056107

"""

from __future__ import annotations

import re

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "8f35e9f1a5a2"
down_revision = "7904ac92bb9f"
branch_labels = None
depends_on = None


_USERNAME_MAX_LEN = 32
_USERNAME_MIN_LEN = 3

_ILLEGAL_CHARS_RE = re.compile(r"[^a-z0-9_]+")
_MULTI_UNDERSCORE_RE = re.compile(r"_+")


def _base_username_from_email(*, email: str | None, user_id: str) -> str:
    local_part = ""
    if email:
        local_part = email.split("@", 1)[0]

    s = local_part.strip().lower()
    s = _ILLEGAL_CHARS_RE.sub("_", s)
    s = _MULTI_UNDERSCORE_RE.sub("_", s)
    s = s.strip("_")
    s = s[:_USERNAME_MAX_LEN]
    s = s.strip("_")

    if len(s) >= _USERNAME_MIN_LEN:
        return s

    compact = user_id.replace("-", "")
    return f"user_{compact[:12]}"


def _dedupe_username(*, base: str, used: set[str], next_suffix: dict[str, int]) -> str:
    if base not in used:
        return base

    suffix = next_suffix.get(base, 2)
    while True:
        suffix_str = f"_{suffix}"
        prefix_len = _USERNAME_MAX_LEN - len(suffix_str)
        if prefix_len <= 0:
            prefix = "u"
        else:
            prefix = base[:prefix_len].rstrip("_")
            if prefix == "":
                prefix = "u"

        candidate = f"{prefix}{suffix_str}"
        if candidate not in used:
            next_suffix[base] = suffix + 1
            return candidate
        suffix += 1


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("username", sa.String(length=_USERNAME_MAX_LEN), nullable=True),
    )

    conn = op.get_bind()

    used_rows = conn.execute(
        sa.text("SELECT username FROM users WHERE username IS NOT NULL")
    ).fetchall()
    used: set[str] = set()
    for (username_val,) in used_rows:
        if username_val is None:
            continue
        used.add(str(username_val).strip().lower())

    rows = conn.execute(
        sa.text("SELECT id, email FROM users WHERE username IS NULL OR username = '' ORDER BY id")
    ).fetchall()

    if rows:
        next_suffix: dict[str, int] = {}
        updates: list[dict[str, str]] = []

        for user_id_val, email_val in rows:
            user_id = str(user_id_val)
            email = None if email_val is None else str(email_val)

            base = _base_username_from_email(email=email, user_id=user_id)
            base = base.strip().lower()[:_USERNAME_MAX_LEN].strip("_")
            if len(base) < _USERNAME_MIN_LEN:
                base = _base_username_from_email(email=None, user_id=user_id)

            username = _dedupe_username(base=base, used=used, next_suffix=next_suffix)
            used.add(username)
            updates.append({"id": user_id, "username": username})

        stmt = sa.text("UPDATE users SET username = :username WHERE id = :id")
        batch_size = 1000
        for i in range(0, len(updates), batch_size):
            _ = conn.execute(stmt, updates[i : i + batch_size])

    op.create_index("ux_users_username", "users", ["username"], unique=True)


def downgrade() -> None:
    op.drop_index("ux_users_username", table_name="users")
    op.drop_column("users", "username")
