# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

import base64
from datetime import datetime
from pathlib import Path
from typing import NoReturn, Protocol, cast

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import GalleryItem, Save
from app.db.session import get_db
from app.workers.celery_app import celery_app
from app.workers.tasks.gallery import task_17_generate_gallery_image


router = APIRouter(prefix="/gallery", tags=["gallery"])

_bearer_scheme = HTTPBearer(auto_error=False)


class GalleryGenerateRequest(BaseModel):
    save_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)


class GalleryGenerateResponse(BaseModel):
    task_id: str
    gallery_id: str
    status: str


class GalleryItemOut(BaseModel):
    id: str
    status: str
    created_at: datetime
    prompt: str
    thumb_data_url: str | None = None
    image_data_url: str | None = None


class _AsyncResult(Protocol):
    id: str | None

    def get(self, timeout: float | int | None = None) -> dict[str, object]: ...


class _GalleryTask(Protocol):
    def delay(self, gallery_id: str) -> _AsyncResult: ...


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


def _server_data_dir() -> Path:
    server_root = Path(__file__).resolve().parents[3]
    return server_root / ".data" / "gallery"


def _file_to_data_url(path: Path) -> str | None:
    try:
        b = path.read_bytes()
    except Exception:
        return None
    if not b:
        return None
    encoded = base64.b64encode(b).decode("ascii")
    return f"data:image/png;base64,{encoded}"


@router.post(
    "/generate",
    response_model=GalleryGenerateResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="gallery_generate",
)
async def gallery_generate(
    payload: GalleryGenerateRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> GalleryGenerateResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=payload.save_id)

    now = datetime.utcnow()
    item = GalleryItem(
        save_id=payload.save_id,
        prompt=payload.prompt,
        status="pending",
        error=None,
        storage_dir="",
        created_at=now,
        completed_at=None,
    )
    db.add(item)
    db.flush()

    base_dir = _server_data_dir() / item.id
    base_dir.mkdir(parents=True, exist_ok=True)
    item.storage_dir = str(base_dir)
    db.commit()
    db.refresh(item)

    task = cast(_GalleryTask, task_17_generate_gallery_image)
    result = task.delay(item.id)

    if bool(getattr(celery_app.conf, "task_always_eager", False)):
        try:
            _ = result.get(timeout=5)
        except Exception:
            pass
        try:
            db.refresh(item)
        except Exception:
            pass

    return GalleryGenerateResponse(
        task_id=cast(str, result.id), gallery_id=item.id, status=item.status
    )


@router.get(
    "/items",
    response_model=list[GalleryItemOut],
    operation_id="gallery_items_list",
)
async def gallery_items_list(
    save_id: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> list[GalleryItemOut]:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=save_id)

    stmt = (
        select(GalleryItem)
        .where(GalleryItem.save_id == save_id)
        .order_by(GalleryItem.created_at.desc())
    )
    items = db.execute(stmt).scalars().all()

    out: list[GalleryItemOut] = []
    for it in items:
        base_dir = Path(it.storage_dir)
        thumb = _file_to_data_url(base_dir / "thumb.png") if it.status == "completed" else None
        image = _file_to_data_url(base_dir / "image.png") if it.status == "completed" else None
        out.append(
            GalleryItemOut(
                id=it.id,
                status=it.status,
                created_at=it.created_at,
                prompt=it.prompt,
                thumb_data_url=thumb,
                image_data_url=image,
            )
        )
    return out
