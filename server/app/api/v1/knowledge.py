# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

import shutil
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import NoReturn, Protocol, cast

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import Float, select
from sqlalchemy.orm import Session
from sqlalchemy.sql import literal

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import KnowledgeChunk, KnowledgeMaterial, Save, Vector
from app.db.session import get_db
from app.services.embedding_provider import embed_text
from app.workers.tasks.knowledge import task_13_index_knowledge_material
from app.workers.celery_app import celery_app


router = APIRouter(prefix="/knowledge", tags=["knowledge"])

_bearer_scheme = HTTPBearer(auto_error=False)


class KnowledgeMaterialOut(BaseModel):
    id: str
    save_id: str
    filename: str
    content_type: str | None
    status: str
    error: str | None
    created_at: datetime
    updated_at: datetime


class KnowledgeMaterialCreateResponse(BaseModel):
    material: KnowledgeMaterialOut


class KnowledgeMaterialDeleteResponse(BaseModel):
    ok: bool = True
    material_id: str


class KnowledgeMaterialReindexResponse(BaseModel):
    material: KnowledgeMaterialOut
    task_id: str | None = None


class KnowledgeQueryRequest(BaseModel):
    save_id: str
    query: str = Field(..., min_length=1)
    top_k: int = Field(5, ge=1, le=50)


class KnowledgeCitation(BaseModel):
    chunk_id: str
    material_id: str
    chunk_index: int
    distance: float
    score: float
    snippet: str


class KnowledgeQueryResponse(BaseModel):
    answer: str
    citations: list[KnowledgeCitation]


class _AsyncResult(Protocol):
    id: str | None

    def get(self, timeout: float | int | None = None) -> dict[str, object]: ...


class _IndexTask(Protocol):
    def delay(self, material_id: str) -> _AsyncResult: ...


def _unauthorized(detail: str = "Unauthorized") -> NoReturn:
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def _get_current_user_id(creds: HTTPAuthorizationCredentials | None) -> str:
    if creds is None:
        _unauthorized()
    if creds.scheme.lower() != "bearer" or creds.credentials == "":
        _unauthorized()
    try:
        payload = decode_access_token(creds.credentials, settings.auth_access_token_secret)
    except Exception:
        _unauthorized()

    sub = payload.get("sub")
    if not isinstance(sub, str) or sub == "":
        _unauthorized()
    return sub


def require_user_id(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> str:
    return _get_current_user_id(creds)


def _get_owned_save_or_404(db: Session, *, user_id: str, save_id: str) -> Save:
    save = db.get(Save, save_id)
    if save is None or save.user_id != user_id or save.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Save not found")
    return save


def _raise_if_pgvector_unavailable(exc: Exception) -> None:
    msg = str(exc).lower()
    if "vector" not in msg:
        return
    if "does not exist" in msg or "undefinedobject" in msg or "undefinedfunction" in msg:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "pgvector 不可用（可能未安装 extension 或未运行迁移）。"
                "请先执行 alembic upgrade head 并确保数据库已启用 pgvector。"
            ),
        ) from exc


def _server_data_dir() -> Path:
    server_root = Path(__file__).resolve().parents[3]
    return server_root / ".data" / "knowledge"


def _material_storage_dir(material_id: str) -> Path:
    base = _server_data_dir().resolve()
    target = (base / material_id).resolve()
    if target.parent != base:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid material_id")
    return target


def _guess_ext(filename: str | None, content_type: str | None) -> str:
    name = (filename or "").lower()
    ctype = (content_type or "").lower()

    if name.endswith(".md") or name.endswith(".markdown") or ctype in {"text/markdown"}:
        return ".md"
    if name.endswith(".txt") or ctype in {"text/plain"}:
        return ".txt"
    if name.endswith(".pdf") or ctype in {"application/pdf"}:
        return ".pdf"
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Unsupported file type (only md/txt/pdf)",
    )


def _material_out(m: KnowledgeMaterial) -> KnowledgeMaterialOut:
    return KnowledgeMaterialOut(
        id=m.id,
        save_id=m.save_id,
        filename=m.filename,
        content_type=m.content_type,
        status=m.status,
        error=m.error,
        created_at=m.created_at,
        updated_at=m.updated_at,
    )


class _UploadTooLarge(Exception):
    pass


def _copy_limited(*, src: object, dst: object, max_bytes: int) -> None:
    if max_bytes <= 0:
        raise _UploadTooLarge()

    read = getattr(src, "read", None)
    write = getattr(dst, "write", None)
    if not callable(read) or not callable(write):
        raise TypeError("src/dst must be file-like")

    remaining = max_bytes
    while True:
        chunk = read(64 * 1024)
        if not chunk:
            return
        if not isinstance(chunk, (bytes, bytearray)):
            raise TypeError("upload read must return bytes")

        if len(chunk) > remaining:
            if remaining > 0:
                _ = write(chunk[:remaining])
            raise _UploadTooLarge()

        _ = write(chunk)
        remaining -= len(chunk)


@router.post(
    "/materials",
    response_model=KnowledgeMaterialCreateResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="knowledge_materials_create",
)
async def knowledge_materials_create(
    save_id: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> KnowledgeMaterialCreateResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)

    ext = _guess_ext(file.filename, file.content_type)
    now = datetime.utcnow()

    material = KnowledgeMaterial(
        save_id=save_id,
        filename=(file.filename or f"upload{ext}"),
        content_type=file.content_type,
        storage_path="",
        status="pending",
        error=None,
        created_at=now,
        updated_at=now,
    )
    db.add(material)
    db.flush()

    base_dir = _server_data_dir() / material.id
    base_dir.mkdir(parents=True, exist_ok=True)
    storage_path = base_dir / f"original{ext}"

    tmp_path = base_dir / f".upload-tmp-{uuid.uuid4().hex}"
    try:
        with tmp_path.open("wb") as f:
            _copy_limited(
                src=file.file, dst=f, max_bytes=int(settings.knowledge_materials_max_bytes)
            )

        os.replace(tmp_path, storage_path)
        material.storage_path = str(storage_path)
        db.commit()
        db.refresh(material)
    except _UploadTooLarge:
        db.rollback()
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            storage_path.unlink(missing_ok=True)
        except Exception:
            pass
        shutil.rmtree(base_dir, ignore_errors=True)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Material payload too large",
        )
    except Exception:
        db.rollback()
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            storage_path.unlink(missing_ok=True)
        except Exception:
            pass
        shutil.rmtree(base_dir, ignore_errors=True)
        raise

    task = cast(_IndexTask, task_13_index_knowledge_material)
    _ = task.delay(material.id)

    return KnowledgeMaterialCreateResponse(material=_material_out(material))


@router.get(
    "/materials",
    response_model=list[KnowledgeMaterialOut],
    operation_id="knowledge_materials_list",
)
async def knowledge_materials_list(
    save_id: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> list[KnowledgeMaterialOut]:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)
    stmt = (
        select(KnowledgeMaterial)
        .where(KnowledgeMaterial.save_id == save_id)
        .order_by(KnowledgeMaterial.created_at.desc())
    )
    items = db.execute(stmt).scalars().all()
    return [_material_out(m) for m in items]


@router.get(
    "/materials/{material_id}",
    response_model=KnowledgeMaterialOut,
    operation_id="knowledge_materials_get",
)
async def knowledge_materials_get(
    material_id: str,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> KnowledgeMaterialOut:
    m = db.get(KnowledgeMaterial, material_id)
    if m is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Material not found")
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=m.save_id)
    return _material_out(m)


@router.delete(
    "/materials/{material_id}",
    response_model=KnowledgeMaterialDeleteResponse,
    operation_id="knowledge_materials_delete",
)
async def knowledge_materials_delete(
    material_id: str,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> KnowledgeMaterialDeleteResponse:
    m = db.get(KnowledgeMaterial, material_id)
    if m is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Material not found")
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=m.save_id)

    storage_dir = _material_storage_dir(material_id)
    db.delete(m)
    db.commit()

    shutil.rmtree(storage_dir, ignore_errors=True)
    return KnowledgeMaterialDeleteResponse(material_id=material_id)


@router.post(
    "/materials/{material_id}/reindex",
    response_model=KnowledgeMaterialReindexResponse,
    operation_id="knowledge_materials_reindex",
)
async def knowledge_materials_reindex(
    material_id: str,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> KnowledgeMaterialReindexResponse:
    m = db.get(KnowledgeMaterial, material_id)
    if m is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Material not found")
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=m.save_id)

    now = datetime.utcnow()
    m.status = "pending"
    m.error = None
    m.updated_at = now
    db.commit()
    db.refresh(m)

    task = cast(_IndexTask, task_13_index_knowledge_material)
    async_result = task.delay(m.id)

    if bool(getattr(celery_app.conf, "task_always_eager", False)):
        try:
            _ = async_result.get(timeout=5)
        except Exception:
            pass
        try:
            db.refresh(m)
        except Exception:
            pass

    try:
        db.refresh(m)
    except Exception:
        pass

    return KnowledgeMaterialReindexResponse(
        material=_material_out(m),
        task_id=async_result.id,
    )


@router.post(
    "/query",
    response_model=KnowledgeQueryResponse,
    operation_id="knowledge_query",
)
async def knowledge_query(
    payload: KnowledgeQueryRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> KnowledgeQueryResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=payload.save_id)

    emb = embed_text(payload.query, db=db)
    query_lit = literal(emb.embedding, type_=Vector(int(emb.embedding_dim)))
    distance_expr = KnowledgeChunk.embedding.op("<->")(query_lit).cast(Float)

    stmt = (
        select(KnowledgeChunk, distance_expr.label("distance"))
        .join(KnowledgeMaterial, KnowledgeMaterial.id == KnowledgeChunk.material_id)
        .where(
            KnowledgeChunk.save_id == payload.save_id,
            KnowledgeMaterial.save_id == payload.save_id,
            KnowledgeMaterial.status == "indexed",
        )
        .order_by(distance_expr.asc())
        .limit(int(payload.top_k))
    )
    try:
        rows = cast(list[tuple[KnowledgeChunk, float]], db.execute(stmt).tuples().all())
    except Exception as e:
        _raise_if_pgvector_unavailable(e)
        raise

    citations: list[KnowledgeCitation] = []
    answer_parts: list[str] = []
    for ch, dist in rows:
        snippet = ch.content.strip().replace("\n", " ")
        if len(snippet) > 220:
            snippet = snippet[:220] + "..."
        score = 1.0 / (1.0 + float(dist))
        citations.append(
            KnowledgeCitation(
                chunk_id=ch.id,
                material_id=ch.material_id,
                chunk_index=ch.chunk_index,
                distance=float(dist),
                score=score,
                snippet=snippet,
            )
        )
        answer_parts.append(ch.content.strip())

    answer = "\n\n".join(answer_parts).strip()
    return KnowledgeQueryResponse(answer=answer, citations=citations)
