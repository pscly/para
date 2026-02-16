# pyright: reportMissingImports=false
# pyright: reportDeprecated=false
# pyright: reportImplicitOverride=false
# pyright: reportIncompatibleMethodOverride=false
# pyright: reportIncompatibleVariableOverride=false
# pyright: reportMissingParameterType=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownParameterType=false
# pyright: reportUnknownVariableType=false
from __future__ import annotations

from datetime import datetime
from typing import Callable, Optional
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import UserDefinedType
from sqlalchemy.engine.interfaces import Dialect

from app.db.base import Base


def _uuid_str() -> str:
    return str(uuid4())


class Vector(UserDefinedType[list[float]]):
    cache_ok: bool | None = True
    dimensions: int

    def __init__(self, dimensions: int):
        if dimensions <= 0:
            raise ValueError("Vector dimensions must be positive")
        self.dimensions = dimensions

    def get_col_spec(self, **_kw: object) -> str:
        return f"vector({self.dimensions})"

    def bind_processor(self, dialect: Dialect) -> Callable[[object], object] | None:
        dims = self.dimensions

        def process(value: object) -> str | None:
            if value is None:
                return None
            if not isinstance(value, (list, tuple)):
                raise TypeError("Vector value must be list/tuple")
            vals_f = [float(x) for x in value]
            if len(vals_f) != dims:
                raise ValueError(f"Vector length must be {dims}")
            vals = ",".join(str(x) for x in vals_f)
            return f"[{vals}]"

        return process

    def result_processor(
        self, dialect: Dialect, coltype: object
    ) -> Callable[[object], object] | None:
        def process(value: object) -> list[float] | None:
            if value is None:
                return None
            if isinstance(value, (list, tuple)):
                return [float(x) for x in value]
            if isinstance(value, str):
                s = value.strip()
                if s.startswith("[") and s.endswith("]"):
                    s = s[1:-1]
                s = s.strip()
                if s == "":
                    return []
                return [float(x) for x in s.split(",")]
            raise TypeError("Unexpected pgvector result type")

        return process


class User(Base):
    __tablename__: str = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    email: Mapped[str] = mapped_column(String(320), index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    devices: Mapped[list["Device"]] = relationship(
        "Device",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        "RefreshToken",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    password_reset_tokens: Mapped[list["PasswordResetToken"]] = relationship(
        "PasswordResetToken",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    saves: Mapped[list["Save"]] = relationship(
        "Save",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Device(Base):
    __tablename__: str = "devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    user: Mapped[User] = relationship("User", back_populates="devices")
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        "RefreshToken",
        back_populates="device",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class RefreshToken(Base):
    __tablename__: str = "refresh_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    device_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("devices.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    user: Mapped[User] = relationship("User", back_populates="refresh_tokens")
    device: Mapped[Device] = relationship("Device", back_populates="refresh_tokens")


class PasswordResetToken(Base):
    __tablename__: str = "password_reset_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    user: Mapped[User] = relationship("User", back_populates="password_reset_tokens")


class AuthRateLimit(Base):
    __tablename__: str = "auth_rate_limits"
    __table_args__: tuple[object, ...] = (
        CheckConstraint("failures >= 0", name="ck_auth_rate_limits_failures_ge_0"),
    )

    key: Mapped[str] = mapped_column(String(512), primary_key=True)
    failures: Mapped[int] = mapped_column(Integer(), nullable=False, default=0)
    reset_at: Mapped[datetime] = mapped_column(DateTime(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class Save(Base):
    __tablename__: str = "saves"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)

    user: Mapped[User] = relationship("User", back_populates="saves")
    persona_binding: Mapped[SavePersonaBinding | None] = relationship(
        "SavePersonaBinding",
        back_populates="save",
        cascade="all, delete-orphan",
        passive_deletes=True,
        uselist=False,
    )

    memory_items: Mapped[list["MemoryItem"]] = relationship(
        "MemoryItem",
        back_populates="save",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    dream_entries: Mapped[list["DreamEntry"]] = relationship(
        "DreamEntry",
        back_populates="save",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    knowledge_materials: Mapped[list["KnowledgeMaterial"]] = relationship(
        "KnowledgeMaterial",
        back_populates="save",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    gallery_items: Mapped[list["GalleryItem"]] = relationship(
        "GalleryItem",
        back_populates="save",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class DreamEntry(Base):
    __tablename__: str = "dream_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    save_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("saves.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    save: Mapped[Save] = relationship("Save", back_populates="dream_entries")


class TimelineEvent(Base):
    __tablename__: str = "timeline_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    save_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    content: Mapped[str] = mapped_column(Text(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )


class MemoryItem(Base):
    __tablename__: str = "memory_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    save_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("saves.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    content: Mapped[str] = mapped_column(Text(), nullable=False)
    source: Mapped[str | None] = mapped_column(String(100), nullable=True)
    trusted: Mapped[bool] = mapped_column(Boolean(), default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)

    save: Mapped[Save] = relationship("Save", back_populates="memory_items")
    embedding: Mapped[Optional["MemoryEmbedding"]] = relationship(
        "MemoryEmbedding",
        back_populates="memory_item",
        cascade="all, delete-orphan",
        passive_deletes=True,
        uselist=False,
    )


class MemoryEmbedding(Base):
    __tablename__: str = "memory_embeddings"

    memory_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("memory_items.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    # 冗余 save_id：便于按 save_id 过滤并配合 pgvector ANN 索引做 KNN 查询。
    save_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    embedding_model: Mapped[str] = mapped_column(
        String(50), default="local-hash-v1", nullable=False
    )
    embedding_dim: Mapped[int] = mapped_column(Integer(), nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    memory_item: Mapped[MemoryItem] = relationship("MemoryItem", back_populates="embedding")


class KnowledgeMaterial(Base):
    __tablename__: str = "knowledge_materials"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    save_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("saves.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    storage_path: Mapped[str] = mapped_column(Text(), nullable=False)

    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    error: Mapped[str | None] = mapped_column(Text(), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    save: Mapped[Save] = relationship("Save", back_populates="knowledge_materials")
    chunks: Mapped[list["KnowledgeChunk"]] = relationship(
        "KnowledgeChunk",
        back_populates="material",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="KnowledgeChunk.chunk_index",
    )


class KnowledgeChunk(Base):
    __tablename__: str = "knowledge_chunks"
    __table_args__: tuple[object, ...] = (
        UniqueConstraint("material_id", "chunk_index", name="uq_knowledge_chunk_material_index"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    material_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("knowledge_materials.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    save_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("saves.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    chunk_index: Mapped[int] = mapped_column(Integer(), nullable=False)
    content: Mapped[str] = mapped_column(Text(), nullable=False)

    embedding_model: Mapped[str] = mapped_column(
        String(50), default="local-hash-v1", nullable=False
    )
    embedding_dim: Mapped[int] = mapped_column(Integer(), nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    material: Mapped[KnowledgeMaterial] = relationship("KnowledgeMaterial", back_populates="chunks")


class GalleryItem(Base):
    __tablename__: str = "gallery_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    save_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("saves.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    prompt: Mapped[str] = mapped_column(Text(), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    error: Mapped[str | None] = mapped_column(Text(), nullable=True)

    storage_dir: Mapped[str] = mapped_column(Text(), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)

    save: Mapped[Save] = relationship("Save", back_populates="gallery_items")


class Persona(Base):
    __tablename__: str = "personas"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    name: Mapped[str] = mapped_column(String(200), unique=True, index=True, nullable=False)
    prompt: Mapped[str] = mapped_column(Text(), nullable=False)
    version: Mapped[int] = mapped_column(Integer(), default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    save_bindings: Mapped[list["SavePersonaBinding"]] = relationship(
        "SavePersonaBinding",
        back_populates="persona",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class SavePersonaBinding(Base):
    __tablename__: str = "save_persona_bindings"

    save_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("saves.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    persona_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("personas.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    bound_at: Mapped[datetime] = mapped_column(DateTime(), default=datetime.utcnow, nullable=False)

    save: Mapped[Save] = relationship("Save", back_populates="persona_binding")
    persona: Mapped[Persona] = relationship("Persona", back_populates="save_bindings")


class Room(Base):
    __tablename__: str = "rooms"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    room_type: Mapped[str] = mapped_column(String(50), nullable=False, default="social")
    created_by_user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )

    members: Mapped[list["RoomMember"]] = relationship(
        "RoomMember",
        back_populates="room",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class RoomMember(Base):
    __tablename__: str = "room_members"
    __table_args__: tuple[object, ...] = (
        UniqueConstraint("room_id", "user_id", name="uq_room_member_room_user"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    room_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("rooms.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    role: Mapped[str] = mapped_column(String(20), nullable=False, default="member")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="invited")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    joined_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)

    room: Mapped[Room] = relationship("Room", back_populates="members")


class UgcAsset(Base):
    __tablename__: str = "ugc_assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    uploaded_by_user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    asset_type: Mapped[str] = mapped_column(String(50), nullable=False)
    manifest_json: Mapped[str] = mapped_column(Text(), nullable=False)

    status: Mapped[str] = mapped_column(String(20), default="pending", index=True, nullable=False)
    storage_path: Mapped[str] = mapped_column(Text(), nullable=False, default="")

    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("admin_users.id", ondelete="SET NULL"),
        nullable=True,
    )
    review_note: Mapped[str | None] = mapped_column(Text(), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )


class AuditLog(Base):
    __tablename__: str = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)

    actor: Mapped[str] = mapped_column(String(50), nullable=False)
    action: Mapped[str] = mapped_column(String(100), nullable=False)

    target_type: Mapped[str] = mapped_column(String(50), nullable=False, default="ugc_asset")
    target_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)

    metadata_json: Mapped[str] = mapped_column(Text(), nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )


class PluginPackage(Base):
    __tablename__: str = "plugin_packages"
    __table_args__: tuple[object, ...] = (
        UniqueConstraint("plugin_id", "version", name="uq_plugin_package_plugin_version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)

    plugin_id: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(50), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    entry: Mapped[str] = mapped_column(String(100), nullable=False)

    permissions_json: Mapped[str] = mapped_column(Text(), nullable=False, default="{}")
    manifest_json: Mapped[str] = mapped_column(Text(), nullable=False)

    code_text: Mapped[str] = mapped_column(Text(), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    status: Mapped[str] = mapped_column(String(20), default="pending", index=True, nullable=False)

    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("admin_users.id", ondelete="SET NULL"),
        nullable=True,
    )
    review_note: Mapped[str | None] = mapped_column(Text(), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class AdminUser(Base):
    __tablename__: str = "admin_users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    email: Mapped[str] = mapped_column(String(320), index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    role: Mapped[str] = mapped_column(String(20), nullable=False, default="operator")
    is_active: Mapped[bool] = mapped_column(Boolean(), nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class AdminKV(Base):
    __tablename__: str = "admin_kv"
    __table_args__: tuple[object, ...] = (
        UniqueConstraint("namespace", "key", name="uq_admin_kv_namespace_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)

    namespace: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    value_json: Mapped[str] = mapped_column(Text(), nullable=False, default="{}")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class AdminLLMChannel(Base):
    __tablename__: str = "admin_llm_channels"
    __table_args__: tuple[object, ...] = (
        UniqueConstraint("name", name="uq_admin_llm_channels_name"),
        CheckConstraint("purpose IN ('chat','embedding')", name="ck_admin_llm_channels_purpose"),
        CheckConstraint("timeout_ms >= 1", name="ck_admin_llm_channels_timeout_ms_ge_1"),
        CheckConstraint("weight >= 0", name="ck_admin_llm_channels_weight_ge_0"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)

    name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    base_url: Mapped[str] = mapped_column(Text(), nullable=False)

    api_key_enc: Mapped[str | None] = mapped_column(Text(), nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean(), nullable=False, default=True)
    purpose: Mapped[str] = mapped_column(String(20), nullable=False, default="chat")

    default_model: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    timeout_ms: Mapped[int] = mapped_column(Integer(), nullable=False, default=60000)
    weight: Mapped[int] = mapped_column(Integer(), nullable=False, default=100)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class WsStream(Base):
    __tablename__: str = "ws_streams"
    __table_args__: tuple[object, ...] = (
        CheckConstraint("next_seq >= 1", name="ck_ws_streams_next_seq_ge_1"),
        CheckConstraint("trimmed_upto_seq >= 0", name="ck_ws_streams_trimmed_upto_seq_ge_0"),
    )

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    save_id: Mapped[str] = mapped_column(String(64), primary_key=True)

    next_seq: Mapped[int] = mapped_column(Integer(), nullable=False, default=1)
    trimmed_upto_seq: Mapped[int] = mapped_column(Integer(), nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class WsEvent(Base):
    __tablename__: str = "ws_events"
    __table_args__: tuple[object, ...] = (
        CheckConstraint("seq >= 1", name="ck_ws_events_seq_ge_1"),
    )

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    save_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer(), primary_key=True)

    frame_type: Mapped[str] = mapped_column(String(50), nullable=False)
    payload_json: Mapped[object | None] = mapped_column(JSONB(), nullable=True)
    ack_required: Mapped[bool] = mapped_column(Boolean(), nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )


class WsDeviceCursor(Base):
    __tablename__: str = "ws_device_cursors"
    __table_args__: tuple[object, ...] = (
        CheckConstraint("last_acked_seq >= 0", name="ck_ws_device_cursors_last_acked_seq_ge_0"),
    )

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    save_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(100), primary_key=True)

    last_acked_seq: Mapped[int] = mapped_column(Integer(), nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class LLMUsageEvent(Base):
    __tablename__: str = "llm_usage_events"
    __table_args__: tuple[object, ...] = (
        CheckConstraint("latency_ms >= 0", name="ck_llm_usage_events_latency_ms_ge_0"),
        CheckConstraint(
            "time_to_first_token_ms IS NULL OR time_to_first_token_ms >= 0",
            name="ck_llm_usage_events_ttft_ms_ge_0",
        ),
        CheckConstraint("output_chunks >= 0", name="ck_llm_usage_events_output_chunks_ge_0"),
        CheckConstraint("output_chars >= 0", name="ck_llm_usage_events_output_chars_ge_0"),
        CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens >= 0",
            name="ck_llm_usage_events_prompt_tokens_ge_0",
        ),
        CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens >= 0",
            name="ck_llm_usage_events_completion_tokens_ge_0",
        ),
        CheckConstraint(
            "total_tokens IS NULL OR total_tokens >= 0",
            name="ck_llm_usage_events_total_tokens_ge_0",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)

    user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    save_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    provider: Mapped[str] = mapped_column(String(50), nullable=False)
    api: Mapped[str] = mapped_column(String(50), nullable=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False)

    started_at: Mapped[datetime] = mapped_column(DateTime(), index=True, nullable=False)
    ended_at: Mapped[datetime] = mapped_column(DateTime(), index=True, nullable=False)

    latency_ms: Mapped[int] = mapped_column(Integer(), nullable=False)
    time_to_first_token_ms: Mapped[int | None] = mapped_column(Integer(), nullable=True)

    output_chunks: Mapped[int] = mapped_column(Integer(), nullable=False)
    output_chars: Mapped[int] = mapped_column(Integer(), nullable=False)

    interrupted: Mapped[bool] = mapped_column(Boolean(), nullable=False, default=False)
    error: Mapped[str | None] = mapped_column(Text(), nullable=True)

    prompt_tokens: Mapped[int | None] = mapped_column(Integer(), nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer(), nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer(), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=datetime.utcnow, nullable=False
    )
