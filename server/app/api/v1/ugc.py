# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false

from __future__ import annotations

import json
import shutil
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import cast

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.saves import require_user_id
from app.core.config import settings
from app.db.models import UgcAsset
from app.db.session import get_db


router = APIRouter(prefix="/ugc", tags=["ugc"])


class UgcAssetOut(BaseModel):
    id: str
    asset_type: str
    status: str
    manifest_json: str
    created_at: datetime
    updated_at: datetime


def _server_data_dir() -> Path:
    server_root = Path(__file__).resolve().parents[3]
    return server_root / ".data" / "ugc"


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


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


def _ugc_allowed_content_types() -> set[str]:
    return {ct.strip().lower() for ct in settings.ugc_assets_allowed_content_types if ct.strip()}


@router.post(
    "/assets",
    response_model=UgcAssetOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="ugc_assets_upload",
)
async def ugc_assets_upload(
    asset_type: str = Form(...),
    manifest_json: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> UgcAssetOut:
    if asset_type.strip() == "":
        raise _bad_request("asset_type must be non-empty")
    if manifest_json.strip() == "":
        raise _bad_request("manifest_json must be non-empty")

    try:
        parsed = cast(object, json.loads(manifest_json))
    except Exception as exc:
        raise _bad_request("manifest_json must be valid JSON") from exc
    manifest_canonical = json.dumps(
        parsed, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    )

    content_type = (file.content_type or "").strip().lower()
    if content_type == "" or content_type not in _ugc_allowed_content_types():
        raise _bad_request("Unsupported content-type")

    now = datetime.utcnow()
    asset = UgcAsset(
        uploaded_by_user_id=user_id,
        asset_type=asset_type,
        manifest_json=manifest_canonical,
        status="pending",
        storage_path="",
        created_at=now,
        updated_at=now,
    )
    db.add(asset)
    db.flush()

    base_dir = _server_data_dir() / asset.id
    base_dir.mkdir(parents=True, exist_ok=True)

    storage_path = base_dir / "original"

    tmp_path = base_dir / f".upload-tmp-{uuid.uuid4().hex}"
    try:
        with tmp_path.open("wb") as f:
            _copy_limited(src=file.file, dst=f, max_bytes=int(settings.ugc_assets_max_bytes))

        os.replace(tmp_path, storage_path)
        asset.storage_path = str(storage_path)
        db.commit()
        db.refresh(asset)
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
            detail="Asset payload too large",
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

    return UgcAssetOut(
        id=asset.id,
        asset_type=asset.asset_type,
        status=asset.status,
        manifest_json=asset.manifest_json,
        created_at=asset.created_at,
        updated_at=asset.updated_at,
    )


@router.get(
    "/assets",
    response_model=list[UgcAssetOut],
    operation_id="ugc_assets_list",
)
async def ugc_assets_list(
    status: str | None = None,
    db: Session = Depends(get_db),
    _user_id: str = Depends(require_user_id),
) -> list[UgcAssetOut]:
    if status is not None and status != "approved":
        raise _bad_request("only status=approved is supported")

    stmt = (
        select(UgcAsset).where(UgcAsset.status == "approved").order_by(UgcAsset.created_at.desc())
    )
    rows = cast(list[UgcAsset], db.execute(stmt).scalars().all())
    return [
        UgcAssetOut(
            id=a.id,
            asset_type=a.asset_type,
            status=a.status,
            manifest_json=a.manifest_json,
            created_at=a.created_at,
            updated_at=a.updated_at,
        )
        for a in rows
    ]
