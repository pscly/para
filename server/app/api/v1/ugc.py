# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import cast

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.saves import require_user_id
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
    with storage_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    asset.storage_path = str(storage_path)
    db.commit()
    db.refresh(asset)

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
