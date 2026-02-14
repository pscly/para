# pyright: reportMissingImports=false
# pyright: reportDeprecated=false
# pyright: reportImplicitOverride=false
# pyright: reportIncompatibleMethodOverride=false
# pyright: reportIncompatibleVariableOverride=false
# pyright: reportMissingParameterType=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownParameterType=false
# pyright: reportUnknownVariableType=false
# pyright: reportAny=false
# pyright: reportExplicitAny=false
# pyright: reportUnannotatedClassAttribute=false
from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Optional
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
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

    def get_col_spec(self, **_kw: Any) -> str:
        return f"vector({self.dimensions})"

    def bind_processor(self, dialect: Dialect) -> Callable[[Any], Any] | None:
        dims = self.dimensions

        def process(value: Any) -> str | None:
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

    def result_processor(self, dialect: Dialect, coltype: Any) -> Callable[[Any], Any] | None:
        def process(value: Any) -> list[float] | None:
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
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
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
