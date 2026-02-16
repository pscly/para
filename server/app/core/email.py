from __future__ import annotations


def normalize_email(email: str) -> str:
    return email.strip().lower()
