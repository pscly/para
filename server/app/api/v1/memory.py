# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from datetime import datetime
from typing import NoReturn, cast

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import Float, select
from sqlalchemy.orm import Session
from sqlalchemy.sql import literal

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import MemoryEmbedding, MemoryItem, Save, Vector
from app.db.session import get_db
from app.services import embedding_provider
from app.services.embedding_local import EMBED_DIM


router = APIRouter(prefix="/memory", tags=["memory"])

_bearer_scheme = HTTPBearer(auto_error=False)


class MemoryIngestRequest(BaseModel):
    save_id: str
    content: str = Field(..., min_length=1)
    source: str | None = None
    trusted: bool = False


class MemoryIngestResponse(BaseModel):
    id: str
    save_id: str
    created_at: datetime


class MemorySearchItem(BaseModel):
    id: str
    content: str
    source: str | None
    trusted: bool
    distance: float
    score: float


class MemoryDeleteResponse(BaseModel):
    id: str
    deleted_at: datetime


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


def _emb_model(emb: object) -> str:
    v = getattr(emb, "model", None)
    if isinstance(v, str) and v.strip() != "":
        return v
    v2 = getattr(emb, "embedding_model", None)
    return v2 if isinstance(v2, str) else ""


def _emb_dim(emb: object) -> int:
    v = getattr(emb, "dim", None)
    if isinstance(v, (int, float)):
        return int(v)
    v2 = getattr(emb, "embedding_dim", None)
    if isinstance(v2, (int, float)):
        return int(v2)
    raise RuntimeError("embedding result missing dim")


@router.post(
    "/ingest",
    response_model=MemoryIngestResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="memory_ingest",
)
async def memory_ingest(
    payload: MemoryIngestRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> MemoryIngestResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=payload.save_id)

    now = datetime.utcnow()
    item = MemoryItem(
        save_id=payload.save_id,
        content=payload.content,
        source=payload.source,
        trusted=payload.trusted,
        created_at=now,
        deleted_at=None,
    )
    db.add(item)
    db.flush()

    emb = embedding_provider.embed_text(payload.content, db=db)
    dim = _emb_dim(emb)
    if dim != EMBED_DIM:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Embedding dim mismatch: expected {EMBED_DIM}, got {dim}",
        )
    db.add(
        MemoryEmbedding(
            memory_id=item.id,
            save_id=item.save_id,
            embedding_model=_emb_model(emb),
            embedding_dim=dim,
            embedding=cast(list[float], getattr(emb, "embedding")),
            created_at=now,
        )
    )
    try:
        db.commit()
    except Exception as e:
        _raise_if_pgvector_unavailable(e)
        raise
    db.refresh(item)
    return MemoryIngestResponse(id=item.id, save_id=item.save_id, created_at=item.created_at)


@router.get(
    "/search",
    response_model=list[MemorySearchItem],
    operation_id="memory_search",
)
async def memory_search(
    q: str = Query(..., min_length=1),
    save_id: str = Query(..., min_length=1),
    limit: int = Query(5, ge=1, le=50),
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> list[MemorySearchItem]:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)

    emb = embedding_provider.embed_text(q, db=db)
    dim = _emb_dim(emb)
    if dim != EMBED_DIM:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Embedding dim mismatch: expected {EMBED_DIM}, got {dim}",
        )
    query_lit = literal(cast(list[float], getattr(emb, "embedding")), type_=Vector(EMBED_DIM))
    distance_expr = MemoryEmbedding.embedding.op("<->")(query_lit).cast(Float)

    candidates = (
        select(
            MemoryEmbedding.memory_id.label("memory_id"),
            distance_expr.label("distance"),
        )
        .where(MemoryEmbedding.save_id == save_id)
        .order_by(distance_expr.asc())
        .limit(limit)
        .cte("candidates")
    )

    stmt = (
        select(MemoryItem, candidates.c.distance)
        .join(candidates, candidates.c.memory_id == MemoryItem.id)
        .where(MemoryItem.deleted_at.is_(None))
        .order_by(candidates.c.distance.asc())
    )
    try:
        rows = cast(list[tuple[MemoryItem, float]], db.execute(stmt).tuples().all())
    except Exception as e:
        _raise_if_pgvector_unavailable(e)
        raise

    out: list[MemorySearchItem] = []
    for item, dist in rows:
        score = 1.0 / (1.0 + float(dist))
        out.append(
            MemorySearchItem(
                id=item.id,
                content=item.content,
                source=item.source,
                trusted=item.trusted,
                distance=float(dist),
                score=score,
            )
        )
    return out


@router.delete(
    "/{memory_id}",
    response_model=MemoryDeleteResponse,
    operation_id="memory_delete",
)
async def memory_delete(
    memory_id: str,
    save_id: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> MemoryDeleteResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)

    item = db.get(MemoryItem, memory_id)
    if item is None or item.save_id != save_id or item.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory not found")

    now = datetime.utcnow()
    item.deleted_at = now

    emb_row = db.get(MemoryEmbedding, memory_id)
    if emb_row is not None:
        db.delete(emb_row)
    db.commit()
    db.refresh(item)
    return MemoryDeleteResponse(id=item.id, deleted_at=cast(datetime, item.deleted_at))
