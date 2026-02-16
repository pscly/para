# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import cast

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.admin_deps import get_current_admin_user, require_super_admin
from app.db.models import AdminUser, AuditLog, PluginPackage, UgcAsset
from app.db.session import get_db


router = APIRouter(prefix="/admin/review", tags=["admin"])


class AdminReviewResponse(BaseModel):
    asset_id: str
    status: str


class AdminPluginReviewResponse(BaseModel):
    id: str
    version: str
    status: str


class ReviewNoteRequest(BaseModel):
    note: str | None = None


class UgcReviewQueueItem(BaseModel):
    asset_id: str
    asset_type: str
    uploaded_by_user_id: str
    status: str
    created_at: datetime
    updated_at: datetime
    reviewed_at: datetime | None
    reviewed_by: str | None
    review_note: str | None


class UgcReviewQueueResponse(BaseModel):
    items: list[UgcReviewQueueItem]
    next_offset: int | None = None


class UgcReviewDetailResponse(BaseModel):
    asset_id: str
    asset_type: str
    uploaded_by_user_id: str
    status: str
    manifest_json: str
    manifest: object | None
    storage_path: str
    created_at: datetime
    updated_at: datetime
    reviewed_at: datetime | None
    reviewed_by: str | None
    review_note: str | None


class PluginReviewQueueItem(BaseModel):
    id: str
    version: str
    name: str
    status: str
    sha256: str
    created_at: datetime
    updated_at: datetime
    reviewed_at: datetime | None
    reviewed_by: str | None
    review_note: str | None


class PluginReviewQueueResponse(BaseModel):
    items: list[PluginReviewQueueItem]
    next_offset: int | None = None


class PluginReviewDetailResponse(BaseModel):
    id: str
    version: str
    name: str
    entry: str
    status: str
    sha256: str
    permissions: object | None
    manifest_json: str
    manifest: object | None
    code: str
    created_at: datetime
    updated_at: datetime
    reviewed_at: datetime | None
    reviewed_by: str | None
    review_note: str | None


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _parse_json_or_none(raw: str) -> object | None:
    try:
        return cast(object, json.loads(raw))
    except Exception:
        return None


def _normalize_note(note_raw: str | None) -> str | None:
    if note_raw is None:
        return None
    note = note_raw.strip()
    if not note:
        return None
    if len(note) > 2000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="note too long (max 2000 chars)",
        )
    return note


def _note_metadata(note: str | None) -> object:
    if note is None:
        return {"len": 0}
    preview = note[:120]
    return {"len": len(note), "sha256": _sha256_hex(note), "preview": preview}


def _audit_metadata(
    *,
    from_status: str,
    to_status: str,
    note_provided: bool,
    note: str | None,
) -> str:
    payload: dict[str, object] = {"from": from_status, "to": to_status}
    if note_provided:
        payload["note"] = _note_metadata(note)
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _review(
    db: Session,
    *,
    asset_id: str,
    to_status: str,
    action: str,
    actor: str,
    reviewed_by: str,
    note_provided: bool,
    note: str | None,
) -> AdminReviewResponse:
    asset = db.get(UgcAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="UGC asset not found")

    from_status = asset.status
    now = datetime.utcnow()

    asset.status = to_status
    asset.updated_at = now
    asset.reviewed_at = now
    asset.reviewed_by = reviewed_by
    if note_provided:
        asset.review_note = note

    log = AuditLog(
        actor=actor,
        action=action,
        target_type="ugc_asset",
        target_id=asset.id,
        metadata_json=_audit_metadata(
            from_status=from_status,
            to_status=to_status,
            note_provided=note_provided,
            note=note,
        ),
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
    actor: str,
    reviewed_by: str,
    note_provided: bool,
    note: str | None,
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
    pkg.reviewed_at = now
    pkg.reviewed_by = reviewed_by
    if note_provided:
        pkg.review_note = note

    log = AuditLog(
        actor=actor,
        action=action,
        target_type="plugin_package",
        target_id=pkg.id,
        metadata_json=_audit_metadata(
            from_status=from_status,
            to_status=to_status,
            note_provided=note_provided,
            note=note,
        ),
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
    payload: ReviewNoteRequest | None = Body(None),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_super_admin),
) -> AdminReviewResponse:
    note: str | None = None
    note_provided = False
    if payload is not None and ("note" in payload.model_fields_set):
        note_provided = True
        note = _normalize_note(payload.note)
    return _review(
        db,
        asset_id=asset_id,
        to_status="approved",
        action="ugc_asset.approve",
        actor=f"admin:{admin.id}",
        reviewed_by=admin.id,
        note_provided=note_provided,
        note=note,
    )


@router.post(
    "/ugc/{asset_id}:reject",
    response_model=AdminReviewResponse,
    operation_id="admin_review_ugc_reject",
)
async def admin_review_ugc_reject(
    asset_id: str,
    payload: ReviewNoteRequest | None = Body(None),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_super_admin),
) -> AdminReviewResponse:
    note: str | None = None
    note_provided = False
    if payload is not None and ("note" in payload.model_fields_set):
        note_provided = True
        note = _normalize_note(payload.note)
    return _review(
        db,
        asset_id=asset_id,
        to_status="rejected",
        action="ugc_asset.reject",
        actor=f"admin:{admin.id}",
        reviewed_by=admin.id,
        note_provided=note_provided,
        note=note,
    )


@router.post(
    "/plugins/{plugin_id}/{version}:approve",
    response_model=AdminPluginReviewResponse,
    operation_id="admin_review_plugin_approve",
)
async def admin_review_plugin_approve(
    plugin_id: str,
    version: str,
    payload: ReviewNoteRequest | None = Body(None),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_super_admin),
) -> AdminPluginReviewResponse:
    note: str | None = None
    note_provided = False
    if payload is not None and ("note" in payload.model_fields_set):
        note_provided = True
        note = _normalize_note(payload.note)
    return _review_plugin(
        db,
        plugin_id=plugin_id,
        version=version,
        to_status="approved",
        action="plugin.approve",
        actor=f"admin:{admin.id}",
        reviewed_by=admin.id,
        note_provided=note_provided,
        note=note,
    )


@router.post(
    "/plugins/{plugin_id}/{version}:reject",
    response_model=AdminPluginReviewResponse,
    operation_id="admin_review_plugin_reject",
)
async def admin_review_plugin_reject(
    plugin_id: str,
    version: str,
    payload: ReviewNoteRequest | None = Body(None),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_super_admin),
) -> AdminPluginReviewResponse:
    note: str | None = None
    note_provided = False
    if payload is not None and ("note" in payload.model_fields_set):
        note_provided = True
        note = _normalize_note(payload.note)
    return _review_plugin(
        db,
        plugin_id=plugin_id,
        version=version,
        to_status="rejected",
        action="plugin.reject",
        actor=f"admin:{admin.id}",
        reviewed_by=admin.id,
        note_provided=note_provided,
        note=note,
    )


@router.get(
    "/ugc",
    response_model=UgcReviewQueueResponse,
    operation_id="admin_review_ugc_queue_list",
)
async def admin_review_ugc_queue_list(
    status: str = Query("pending", min_length=1, max_length=20),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> UgcReviewQueueResponse:
    stmt = select(UgcAsset).where(UgcAsset.status == status)
    stmt = (
        stmt.order_by(UgcAsset.created_at.asc(), UgcAsset.id.asc()).offset(offset).limit(limit + 1)
    )
    rows = list(db.execute(stmt).scalars().all())
    more = len(rows) > limit
    page = rows[:limit]

    items = [
        UgcReviewQueueItem(
            asset_id=a.id,
            asset_type=a.asset_type,
            uploaded_by_user_id=a.uploaded_by_user_id,
            status=a.status,
            created_at=a.created_at,
            updated_at=a.updated_at,
            reviewed_at=a.reviewed_at,
            reviewed_by=a.reviewed_by,
            review_note=a.review_note,
        )
        for a in page
    ]
    next_offset = (offset + len(page)) if more else None
    return UgcReviewQueueResponse(items=items, next_offset=next_offset)


@router.get(
    "/ugc/{asset_id}",
    response_model=UgcReviewDetailResponse,
    operation_id="admin_review_ugc_queue_detail",
)
async def admin_review_ugc_queue_detail(
    asset_id: str,
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> UgcReviewDetailResponse:
    asset = db.get(UgcAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="UGC asset not found")

    return UgcReviewDetailResponse(
        asset_id=asset.id,
        asset_type=asset.asset_type,
        uploaded_by_user_id=asset.uploaded_by_user_id,
        status=asset.status,
        manifest_json=asset.manifest_json,
        manifest=_parse_json_or_none(asset.manifest_json),
        storage_path=asset.storage_path,
        created_at=asset.created_at,
        updated_at=asset.updated_at,
        reviewed_at=asset.reviewed_at,
        reviewed_by=asset.reviewed_by,
        review_note=asset.review_note,
    )


@router.post(
    "/ugc/{asset_id}:note",
    response_model=UgcReviewDetailResponse,
    operation_id="admin_review_ugc_queue_note",
)
async def admin_review_ugc_queue_note(
    asset_id: str,
    payload: ReviewNoteRequest,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_super_admin),
) -> UgcReviewDetailResponse:
    asset = db.get(UgcAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="UGC asset not found")

    note = _normalize_note(payload.note)
    from_status = asset.status
    now = datetime.utcnow()

    asset.review_note = note
    asset.updated_at = now

    db.add(
        AuditLog(
            actor=f"admin:{admin.id}",
            action="ugc_asset.review_note",
            target_type="ugc_asset",
            target_id=asset.id,
            metadata_json=_audit_metadata(
                from_status=from_status,
                to_status=from_status,
                note_provided=True,
                note=note,
            ),
            created_at=now,
        )
    )
    db.commit()
    db.refresh(asset)

    return UgcReviewDetailResponse(
        asset_id=asset.id,
        asset_type=asset.asset_type,
        uploaded_by_user_id=asset.uploaded_by_user_id,
        status=asset.status,
        manifest_json=asset.manifest_json,
        manifest=_parse_json_or_none(asset.manifest_json),
        storage_path=asset.storage_path,
        created_at=asset.created_at,
        updated_at=asset.updated_at,
        reviewed_at=asset.reviewed_at,
        reviewed_by=asset.reviewed_by,
        review_note=asset.review_note,
    )


@router.get(
    "/plugins",
    response_model=PluginReviewQueueResponse,
    operation_id="admin_review_plugins_queue_list",
)
async def admin_review_plugins_queue_list(
    status: str = Query("pending", min_length=1, max_length=20),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> PluginReviewQueueResponse:
    stmt = select(PluginPackage).where(PluginPackage.status == status)
    stmt = (
        stmt.order_by(PluginPackage.created_at.asc(), PluginPackage.id.asc())
        .offset(offset)
        .limit(limit + 1)
    )
    rows = list(db.execute(stmt).scalars().all())
    more = len(rows) > limit
    page = rows[:limit]

    items = [
        PluginReviewQueueItem(
            id=p.plugin_id,
            version=p.version,
            name=p.name,
            status=p.status,
            sha256=p.sha256,
            created_at=p.created_at,
            updated_at=p.updated_at,
            reviewed_at=p.reviewed_at,
            reviewed_by=p.reviewed_by,
            review_note=p.review_note,
        )
        for p in page
    ]
    next_offset = (offset + len(page)) if more else None
    return PluginReviewQueueResponse(items=items, next_offset=next_offset)


@router.get(
    "/plugins/{plugin_id}/{version}",
    response_model=PluginReviewDetailResponse,
    operation_id="admin_review_plugins_queue_detail",
)
async def admin_review_plugins_queue_detail(
    plugin_id: str,
    version: str,
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> PluginReviewDetailResponse:
    stmt = select(PluginPackage).where(
        PluginPackage.plugin_id == plugin_id,
        PluginPackage.version == version,
    )
    pkg = db.execute(stmt).scalar_one_or_none()
    if pkg is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Plugin package not found"
        )

    perms = _parse_json_or_none(pkg.permissions_json)
    manifest = _parse_json_or_none(pkg.manifest_json)
    return PluginReviewDetailResponse(
        id=pkg.plugin_id,
        version=pkg.version,
        name=pkg.name,
        entry=pkg.entry,
        status=pkg.status,
        sha256=pkg.sha256,
        permissions=perms,
        manifest_json=pkg.manifest_json,
        manifest=manifest,
        code=pkg.code_text,
        created_at=pkg.created_at,
        updated_at=pkg.updated_at,
        reviewed_at=pkg.reviewed_at,
        reviewed_by=pkg.reviewed_by,
        review_note=pkg.review_note,
    )


@router.post(
    "/plugins/{plugin_id}/{version}:note",
    response_model=PluginReviewDetailResponse,
    operation_id="admin_review_plugins_queue_note",
)
async def admin_review_plugins_queue_note(
    plugin_id: str,
    version: str,
    payload: ReviewNoteRequest,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_super_admin),
) -> PluginReviewDetailResponse:
    stmt = select(PluginPackage).where(
        PluginPackage.plugin_id == plugin_id,
        PluginPackage.version == version,
    )
    pkg = db.execute(stmt).scalar_one_or_none()
    if pkg is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Plugin package not found"
        )

    note = _normalize_note(payload.note)
    from_status = pkg.status
    now = datetime.utcnow()

    pkg.review_note = note
    pkg.updated_at = now

    db.add(
        AuditLog(
            actor=f"admin:{admin.id}",
            action="plugin.review_note",
            target_type="plugin_package",
            target_id=pkg.id,
            metadata_json=_audit_metadata(
                from_status=from_status,
                to_status=from_status,
                note_provided=True,
                note=note,
            ),
            created_at=now,
        )
    )
    db.commit()
    db.refresh(pkg)

    return PluginReviewDetailResponse(
        id=pkg.plugin_id,
        version=pkg.version,
        name=pkg.name,
        entry=pkg.entry,
        status=pkg.status,
        sha256=pkg.sha256,
        permissions=_parse_json_or_none(pkg.permissions_json),
        manifest_json=pkg.manifest_json,
        manifest=_parse_json_or_none(pkg.manifest_json),
        code=pkg.code_text,
        created_at=pkg.created_at,
        updated_at=pkg.updated_at,
        reviewed_at=pkg.reviewed_at,
        reviewed_by=pkg.reviewed_by,
        review_note=pkg.review_note,
    )
