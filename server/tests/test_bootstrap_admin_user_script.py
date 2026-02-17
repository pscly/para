# pyright: reportMissingImports=false

from __future__ import annotations

from app.core.email import normalize_email
from app.scripts.bootstrap_admin_user import (
    BOOTSTRAP_MIN_PASSWORD_LEN,
    generate_random_password,
    validate_bootstrap_password,
)


def test_bootstrap_generate_random_password_meets_policy() -> None:
    pw = generate_random_password()
    assert len(pw) >= BOOTSTRAP_MIN_PASSWORD_LEN
    assert not any(ch.isspace() for ch in pw)
    assert any(ch.isalpha() for ch in pw)
    assert any(ch.isdigit() for ch in pw)
    validate_bootstrap_password(pw)


def test_bootstrap_normalize_email_matches_auth_path() -> None:
    assert normalize_email("  Admin@Example.Com  ") == "admin@example.com"
