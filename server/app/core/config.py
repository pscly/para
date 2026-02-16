# pyright: reportMissingImports=false

from __future__ import annotations

from functools import lru_cache
import json
import secrets
import base64
import hashlib
from typing import ClassVar, cast

from pydantic import Field, field_validator, model_validator
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

    env: str = "dev"

    cors_allowed_origins: list[str] = Field(default_factory=list)
    trusted_hosts: list[str] = Field(default_factory=list)

    # Auth (JWT) settings
    auth_access_token_secret: str = "dev-secret-change-me"
    auth_access_token_ttl_seconds: int = 900
    auth_refresh_token_ttl_days: int = 30

    password_reset_token_ttl_minutes: int = 30

    auth_rate_limit_enabled: bool = True
    auth_rate_limit_max_failures: int = 5
    auth_rate_limit_window_seconds: int = 300

    admin_access_token_secret: str = "dev-admin-secret-change-me"
    admin_access_token_ttl_seconds: int = 3600

    admin_secrets_master_key: bytes | None = None

    audit_log_retention_days: int = 90

    ws_max_devices_per_save: int = 20
    ws_max_device_id_length: int = 100

    openai_mode: str = "fake"
    openai_base_url: str | None = None
    openai_api_key: str | None = None
    openai_model: str | None = None
    openai_api: str = "auto"

    knowledge_embedding_provider: str = "local"
    openai_embeddings_model: str = "text-embedding-3-small"
    openai_embeddings_timeout_seconds: float = 10.0

    knowledge_materials_max_bytes: int = 20 * 1024 * 1024
    ugc_assets_max_bytes: int = 10 * 1024 * 1024
    plugins_upload_max_bytes: int = 2 * 1024 * 1024

    ugc_assets_allowed_content_types: list[str] = Field(
        default_factory=lambda: [
            "application/octet-stream",
            "image/png",
            "image/jpeg",
        ]
    )

    # Legacy shared-secret admin guard (deprecated).
    # Kept for backwards compatibility with old deployments/config, but no longer
    # required in production now that admin endpoints use admin JWT + RBAC.
    admin_review_secret: str = Field(default_factory=lambda: secrets.token_urlsafe(32))

    # Prefer DATABASE_URL when provided; otherwise construct from POSTGRES_* vars.
    database_url: str | None = None
    postgres_db: str = "para"
    postgres_user: str = "para"
    postgres_password: str = "para"
    postgres_host: str = "localhost"
    postgres_port: int = 5432

    para_appenc_enabled: bool = False
    para_appenc_keys: dict[str, bytes] = Field(default_factory=dict)
    para_appenc_ts_window_sec: int = 120

    @field_validator("para_appenc_keys", mode="before")
    @classmethod
    def _parse_appenc_keys_env(cls, v: object) -> dict[str, bytes]:
        def b64url_decode(raw: str) -> bytes:
            s = raw.strip()
            if s == "":
                return b""
            pad = "=" * ((4 - (len(s) % 4)) % 4)
            try:
                return base64.urlsafe_b64decode((s + pad).encode("ascii"))
            except Exception as e:
                raise ValueError("PARA_APPENC_KEYS contains invalid base64url") from e

        if v is None:
            return {}

        out_map: dict[str, bytes] = {}

        if isinstance(v, dict):
            v_dict = cast(dict[object, object], v)
            for k_obj, val_obj in v_dict.items():
                kid = (k_obj if isinstance(k_obj, str) else str(k_obj)).strip()
                if not kid:
                    continue
                if isinstance(val_obj, (bytes, bytearray)):
                    key_bytes = bytes(val_obj)
                else:
                    key_bytes = b64url_decode(str(val_obj))
                if len(key_bytes) != 32:
                    raise ValueError("PARA_APPENC_KEYS key must be 32 bytes")
                out_map[kid] = key_bytes
            return out_map

        if isinstance(v, str):
            raw = v.strip()
            if raw == "":
                return {}
            parts: list[str] = []
            for chunk in raw.replace("\n", ",").replace("\t", ",").split(","):
                s = chunk.strip()
                if s:
                    parts.append(s)
            for item in parts:
                if ":" not in item:
                    raise ValueError("PARA_APPENC_KEYS must be 'kid:base64url_key' pairs")
                kid_raw, key_raw = item.split(":", 1)
                kid = kid_raw.strip()
                if kid == "":
                    raise ValueError("PARA_APPENC_KEYS contains empty kid")
                key_bytes = b64url_decode(key_raw)
                if len(key_bytes) != 32:
                    raise ValueError("PARA_APPENC_KEYS key must be 32 bytes")
                out_map[kid] = key_bytes
            return out_map

        return {}

    @field_validator("admin_secrets_master_key", mode="before")
    @classmethod
    def _parse_admin_secrets_master_key(cls, v: object) -> bytes | None:
        if v is None:
            return None
        if isinstance(v, (bytes, bytearray)):
            raw_bytes = bytes(v)
            if raw_bytes == b"":
                return None
            if len(raw_bytes) != 32:
                raise ValueError("ADMIN_SECRETS_MASTER_KEY must be 32 bytes")
            return raw_bytes
        if isinstance(v, str):
            s = v.strip()
            if s == "":
                return None
            pad = "=" * ((4 - (len(s) % 4)) % 4)
            try:
                key_bytes = base64.urlsafe_b64decode((s + pad).encode("ascii"))
            except Exception as e:
                raise ValueError("ADMIN_SECRETS_MASTER_KEY contains invalid base64url") from e
            if len(key_bytes) != 32:
                raise ValueError("ADMIN_SECRETS_MASTER_KEY must decode to 32 bytes")
            return key_bytes
        return cast(bytes, v)

    @property
    def admin_secrets_master_key_bytes(self) -> bytes:
        if self.admin_secrets_master_key is not None:
            return self.admin_secrets_master_key

        seed = (self.admin_access_token_secret + "|admin_secrets_master_key|v1").encode("utf-8")
        return hashlib.sha256(seed).digest()

    @property
    def para_appenc_primary_kid(self) -> str | None:
        for k in self.para_appenc_keys.keys():
            return k
        return None

    @field_validator("cors_allowed_origins", "trusted_hosts", mode="before")
    @classmethod
    def _parse_listish_env(cls, v: object) -> list[str]:
        if v is None:
            return []
        if isinstance(v, list):
            v_list = cast(list[object], v)
            return [str(x).strip() for x in v_list if str(x).strip()]
        if isinstance(v, str):
            raw = v.strip()
            if raw == "":
                return []
            if raw.lstrip().startswith("["):
                try:
                    parsed: object = cast(object, json.loads(raw))
                except Exception:
                    parsed = None
                if isinstance(parsed, list):
                    parsed_list = cast(list[object], parsed)
                    return [str(x).strip() for x in parsed_list if str(x).strip()]
            parts: list[str] = []
            for chunk in raw.replace("\n", ",").replace("\t", ",").split(","):
                s = chunk.strip()
                if s:
                    parts.append(s)
            return parts
        return [str(v).strip()] if str(v).strip() else []

    @property
    def sqlalchemy_database_uri(self) -> str:
        if self.database_url:
            return self.database_url
        return (
            f"postgresql+psycopg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    def _is_prod_env(self) -> bool:
        return self.env.strip().lower() in ("prod", "production")

    @model_validator(mode="after")
    def _validate_prod_config(self) -> "Settings":
        if not self._is_prod_env():
            return self

        problems: list[str] = []

        if self.auth_access_token_secret.strip() in ("", "dev-secret-change-me"):
            problems.append(
                "AUTH_ACCESS_TOKEN_SECRET must be set in production (cannot use default 'dev-secret-change-me')."
            )
        if self.admin_access_token_secret.strip() in ("", "dev-admin-secret-change-me"):
            problems.append(
                "ADMIN_ACCESS_TOKEN_SECRET must be set in production (cannot use default 'dev-admin-secret-change-me')."
            )

        if self.openai_mode.strip().lower() == "fake":
            problems.append("OPENAI_MODE=fake is forbidden in production. Set OPENAI_MODE=openai.")

        if self.knowledge_embedding_provider.strip().lower() == "local":
            problems.append(
                "KNOWLEDGE_EMBEDDING_PROVIDER=local is forbidden in production. Set KNOWLEDGE_EMBEDDING_PROVIDER=openai."
            )

        if self.admin_secrets_master_key is None:
            problems.append(
                "ADMIN_SECRETS_MASTER_KEY must be set in production (base64url 32 bytes)."
            )

        if problems:
            details = "\n".join(f"- {p}" for p in problems)
            raise ValueError(
                f"Production settings validation failed (ENV={self.env!r}). Fix the following before starting the server:\n"
                + details
            )

        return self

    @model_validator(mode="after")
    def _validate_embeddings_config(self) -> "Settings":
        provider = self.knowledge_embedding_provider.strip().lower()
        if provider not in ("local", "openai"):
            raise ValueError("KNOWLEDGE_EMBEDDING_PROVIDER must be one of: local, openai")
        if provider == "openai":
            if not (self.openai_base_url and self.openai_base_url.strip()):
                raise ValueError("OPENAI_BASE_URL must be set when using OpenAI embeddings")
            if not (self.openai_api_key and self.openai_api_key.strip()):
                raise ValueError("OPENAI_API_KEY must be set when using OpenAI embeddings")
        return self

    @model_validator(mode="after")
    def _validate_appenc_config(self) -> "Settings":
        if not self.para_appenc_enabled:
            return self
        if not self.para_appenc_keys:
            raise ValueError("PARA_APPENC_ENABLED=1 requires PARA_APPENC_KEYS")
        if self.para_appenc_ts_window_sec <= 0:
            raise ValueError("PARA_APPENC_TS_WINDOW_SEC must be > 0")
        if not self.para_appenc_primary_kid:
            raise ValueError("PARA_APPENC_KEYS must include at least one key")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
