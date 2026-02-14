# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false

from __future__ import annotations

import hmac
import json
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models import AuditLog, PluginPackage, UgcAsset
from app.db.session import get_db


router = APIRouter(prefix="/admin/review", tags=["admin"])


class AdminReviewResponse(BaseModel):
    asset_id: str
    status: str


class AdminPluginReviewResponse(BaseModel):
    id: str
    version: str
    status: str


def _unauthorized(detail: str = "Unauthorized") -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def _require_admin_secret(x_admin_secret: str | None) -> None:
    expected = settings.admin_review_secret
    provided = x_admin_secret or ""
    if expected == "" or provided == "":
        raise _unauthorized("Missing admin secret")
    if not hmac.compare_digest(provided, expected):
        raise _unauthorized("Invalid admin secret")


def _audit_metadata(*, from_status: str, to_status: str) -> str:
    payload = {"from": from_status, "to": to_status}
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _review(
    db: Session,
    *,
    asset_id: str,
    to_status: str,
    action: str,
) -> AdminReviewResponse:
    asset = db.get(UgcAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="UGC asset not found")

    from_status = asset.status
    now = datetime.utcnow()

    asset.status = to_status
    asset.updated_at = now

    log = AuditLog(
        actor="admin",
        action=action,
        target_type="ugc_asset",
        target_id=asset.id,
        metadata_json=_audit_metadata(from_status=from_status, to_status=to_status),
        created_at=now,
    )
    db.add(log)
    db.commit()
    db.refresh(asset)

    return AdminReviewResponse(asset_id=asset.id, status=asset.status)


def _review_plugin(
    db: Session,
    *,
    plugin_id: str,
    version: str,
    to_status: str,
    action: str,
) -> AdminPluginReviewResponse:
    stmt = select(PluginPackage).where(
        PluginPackage.plugin_id == plugin_id,
        PluginPackage.version == version,
    )
    pkg = db.execute(stmt).scalar_one_or_none()
    if pkg is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Plugin package not found",
        )

    from_status = pkg.status
    now = datetime.utcnow()

    pkg.status = to_status
    pkg.updated_at = now

    log = AuditLog(
        actor="admin",
        action=action,
        target_type="plugin_package",
        target_id=pkg.id,
        metadata_json=_audit_metadata(from_status=from_status, to_status=to_status),
        created_at=now,
    )
    db.add(log)
    db.commit()
    db.refresh(pkg)

    return AdminPluginReviewResponse(id=pkg.plugin_id, version=pkg.version, status=pkg.status)


@router.post(
    "/ugc/{asset_id}:approve",
    response_model=AdminReviewResponse,
    operation_id="admin_review_ugc_approve",
)
async def admin_review_ugc_approve(
    asset_id: str,
    db: Session = Depends(get_db),
    x_admin_secret: str | None = Header(None, alias="X-Admin-Secret"),
) -> AdminReviewResponse:
    _require_admin_secret(x_admin_secret)
    return _review(db, asset_id=asset_id, to_status="approved", action="ugc_asset.approve")


@router.post(
    "/ugc/{asset_id}:reject",
    response_model=AdminReviewResponse,
    operation_id="admin_review_ugc_reject",
)
async def admin_review_ugc_reject(
    asset_id: str,
    db: Session = Depends(get_db),
    x_admin_secret: str | None = Header(None, alias="X-Admin-Secret"),
) -> AdminReviewResponse:
    _require_admin_secret(x_admin_secret)
    return _review(db, asset_id=asset_id, to_status="rejected", action="ugc_asset.reject")


@router.post(
    "/plugins/{plugin_id}/{version}:approve",
    response_model=AdminPluginReviewResponse,
    operation_id="admin_review_plugin_approve",
)
async def admin_review_plugin_approve(
    plugin_id: str,
    version: str,
    db: Session = Depends(get_db),
    x_admin_secret: str | None = Header(None, alias="X-Admin-Secret"),
) -> AdminPluginReviewResponse:
    _require_admin_secret(x_admin_secret)
    return _review_plugin(
        db,
        plugin_id=plugin_id,
        version=version,
        to_status="approved",
        action="plugin.approve",
    )


@router.post(
    "/plugins/{plugin_id}/{version}:reject",
    response_model=AdminPluginReviewResponse,
    operation_id="admin_review_plugin_reject",
)
async def admin_review_plugin_reject(
    plugin_id: str,
    version: str,
    db: Session = Depends(get_db),
    x_admin_secret: str | None = Header(None, alias="X-Admin-Secret"),
) -> AdminPluginReviewResponse:
    _require_admin_secret(x_admin_secret)
    return _review_plugin(
        db,
        plugin_id=plugin_id,
        version=version,
        to_status="rejected",
        action="plugin.reject",
    )
