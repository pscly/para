# pyright: reportMissingImports=false

from __future__ import annotations

from functools import lru_cache
import secrets
from typing import ClassVar

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven settings with local dev defaults."""

    model_config: ClassVar[SettingsConfigDict] = SettingsConfigDict(
        env_file=None,
        case_sensitive=False,
        extra="ignore",
    )

    api_v1_prefix: str = "/api/v1"
    log_level: str = "INFO"

    # Auth (JWT) settings
    auth_access_token_secret: str = "dev-secret-change-me"
    auth_access_token_ttl_seconds: int = 900
    auth_refresh_token_ttl_days: int = 30

    admin_access_token_secret: str = "dev-admin-secret-change-me"
    admin_access_token_ttl_seconds: int = 3600

    audit_log_retention_days: int = 90

    # Minimal admin review guard (for high-risk flows like UGC).
    # Default is a per-process random secret suitable for local/test.
    admin_review_secret: str = secrets.token_urlsafe(32)

    # Prefer DATABASE_URL when provided; otherwise construct from POSTGRES_* vars.
    database_url: str | None = None
    postgres_db: str = "para"
    postgres_user: str = "para"
    postgres_password: str = "para"
    postgres_host: str = "localhost"
    postgres_port: int = 5432

    @property
    def sqlalchemy_database_uri(self) -> str:
        if self.database_url:
            return self.database_url
        return (
            f"postgresql+psycopg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
