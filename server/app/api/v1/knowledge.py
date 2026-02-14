# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path
from typing import NoReturn, Protocol, cast

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import Float, select, text
from sqlalchemy.orm import Session
from sqlalchemy.sql import literal

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import KnowledgeChunk, KnowledgeMaterial, Save, Vector
from app.db.session import get_db
from app.services.embedding_local import EMBED_DIM, local_embed
from app.workers.tasks.knowledge import task_13_index_knowledge_material


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


def _ensure_pgvector(db: Session) -> None:
    try:
        _ = db.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        db.commit()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to enable pgvector extension: {e}",
        )


def _server_data_dir() -> Path:
    server_root = Path(__file__).resolve().parents[3]
    return server_root / ".data" / "knowledge"


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
    _ensure_pgvector(db)

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

    with storage_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    material.storage_path = str(storage_path)
    db.commit()
    db.refresh(material)

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
    _ensure_pgvector(db)

    query_vec = local_embed(payload.query)
    query_lit = literal(query_vec, type_=Vector(EMBED_DIM))
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
    rows = cast(list[tuple[KnowledgeChunk, float]], db.execute(stmt).tuples().all())

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
