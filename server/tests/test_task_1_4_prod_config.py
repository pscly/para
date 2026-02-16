# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false

from __future__ import annotations

import pytest

from app.core.config import Settings


def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in [
        "ENV",
        "AUTH_ACCESS_TOKEN_SECRET",
        "ADMIN_ACCESS_TOKEN_SECRET",
        "ADMIN_SECRETS_MASTER_KEY",
        "ADMIN_REVIEW_SECRET",
        "OPENAI_MODE",
        "KNOWLEDGE_EMBEDDING_PROVIDER",
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
    ]:
        monkeypatch.delenv(key, raising=False)


_TEST_ADMIN_SECRETS_MASTER_KEY_B64URL = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"


def test_prod_default_placeholders_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.setenv("ADMIN_SECRETS_MASTER_KEY", _TEST_ADMIN_SECRETS_MASTER_KEY_B64URL)

    with pytest.raises(Exception) as excinfo:
        _ = Settings()
    msg = str(excinfo.value)
    assert "AUTH_ACCESS_TOKEN_SECRET" in msg
    assert "ADMIN_ACCESS_TOKEN_SECRET" in msg
    assert "ADMIN_REVIEW_SECRET" not in msg


def test_prod_missing_admin_review_secret_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("AUTH_ACCESS_TOKEN_SECRET", "auth-secret-set-in-prod-0123456789")
    monkeypatch.setenv("ADMIN_ACCESS_TOKEN_SECRET", "admin-secret-set-in-prod-0123456789")
    monkeypatch.setenv("ADMIN_SECRETS_MASTER_KEY", _TEST_ADMIN_SECRETS_MASTER_KEY_B64URL)
    monkeypatch.setenv("OPENAI_MODE", "openai")
    monkeypatch.setenv("KNOWLEDGE_EMBEDDING_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://localhost/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "not-a-real-key")

    s = Settings()
    assert s.env.lower() == "production"
    assert s.auth_access_token_secret == "auth-secret-set-in-prod-0123456789"
    assert s.admin_access_token_secret == "admin-secret-set-in-prod-0123456789"
    assert isinstance(s.admin_review_secret, str)
    assert s.admin_review_secret.strip() != ""


def test_prod_all_secrets_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.setenv("AUTH_ACCESS_TOKEN_SECRET", "auth-secret-set-in-prod-0123456789")
    monkeypatch.setenv("ADMIN_ACCESS_TOKEN_SECRET", "admin-secret-set-in-prod-0123456789")
    monkeypatch.setenv("ADMIN_SECRETS_MASTER_KEY", _TEST_ADMIN_SECRETS_MASTER_KEY_B64URL)
    monkeypatch.setenv("ADMIN_REVIEW_SECRET", "review-secret-set-in-prod-0123456789")
    monkeypatch.setenv("OPENAI_MODE", "openai")
    monkeypatch.setenv("KNOWLEDGE_EMBEDDING_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://localhost/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "not-a-real-key")

    s = Settings()
    assert s.env.lower() == "prod"
    assert s.admin_review_secret == "review-secret-set-in-prod-0123456789"


def test_prod_forbids_openai_mode_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.setenv("AUTH_ACCESS_TOKEN_SECRET", "auth-secret-set-in-prod-0123456789")
    monkeypatch.setenv("ADMIN_ACCESS_TOKEN_SECRET", "admin-secret-set-in-prod-0123456789")
    monkeypatch.setenv("OPENAI_MODE", "fake")
    monkeypatch.setenv("KNOWLEDGE_EMBEDDING_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://localhost/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "not-a-real-key")

    with pytest.raises(Exception) as excinfo:
        _ = Settings()
    msg = str(excinfo.value)
    assert "OPENAI_MODE=fake" in msg


def test_prod_forbids_local_embeddings(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("AUTH_ACCESS_TOKEN_SECRET", "auth-secret-set-in-prod-0123456789")
    monkeypatch.setenv("ADMIN_ACCESS_TOKEN_SECRET", "admin-secret-set-in-prod-0123456789")
    monkeypatch.setenv("OPENAI_MODE", "openai")
    monkeypatch.setenv("KNOWLEDGE_EMBEDDING_PROVIDER", "local")

    with pytest.raises(Exception) as excinfo:
        _ = Settings()
    msg = str(excinfo.value)
    assert "KNOWLEDGE_EMBEDDING_PROVIDER=local" in msg


@pytest.mark.parametrize("env_value", ["dev", "test"])
def test_non_prod_missing_admin_review_secret_is_auto_generated(
    monkeypatch: pytest.MonkeyPatch,
    env_value: str,
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("ENV", env_value)

    s = Settings()
    assert isinstance(s.admin_review_secret, str)
    assert s.admin_review_secret.strip() != ""
