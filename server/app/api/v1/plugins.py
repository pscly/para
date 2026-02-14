# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime
from typing import cast

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.v1.saves import require_user_id
from app.core.config import settings
from app.db.models import PluginPackage
from app.db.session import get_db


router = APIRouter(prefix="/plugins", tags=["plugins"])


class PluginUploadRequest(BaseModel):
    manifest_json: str
    code: str


class PluginUploadResponse(BaseModel):
    id: str
    version: str
    status: str
    sha256: str


class PluginListItem(BaseModel):
    id: str
    version: str
    name: str
    sha256: str
    permissions: object


class PluginDownloadResponse(BaseModel):
    manifest_json: str
    code: str
    sha256: str


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def _unauthorized(detail: str = "Unauthorized") -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def _require_admin_secret(x_admin_secret: str | None) -> None:
    expected = settings.admin_review_secret
    provided = x_admin_secret or ""
    if expected == "" or provided == "":
        raise _unauthorized("Missing admin secret")
    if not hmac.compare_digest(provided, expected):
        raise _unauthorized("Invalid admin secret")


def _canonical_json(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _extract_manifest_fields(manifest_obj: object) -> tuple[str, str, str, str, object, str, str]:
    if not isinstance(manifest_obj, dict):
        raise _bad_request("manifest_json must be a JSON object")

    pid = manifest_obj.get("id")
    version = manifest_obj.get("version")
    name = manifest_obj.get("name")
    entry = manifest_obj.get("entry")
    permissions = manifest_obj.get("permissions")

    if not isinstance(pid, str) or pid.strip() == "":
        raise _bad_request("manifest.id must be a non-empty string")
    if not isinstance(version, str) or version.strip() == "":
        raise _bad_request("manifest.version must be a non-empty string")
    if not isinstance(name, str) or name.strip() == "":
        raise _bad_request("manifest.name must be a non-empty string")
    if not isinstance(entry, str) or entry.strip() == "":
        raise _bad_request("manifest.entry must be a non-empty string")
    if entry != "index.js":
        raise _bad_request("manifest.entry must be 'index.js'")

    if permissions is None:
        raise _bad_request("manifest.permissions is required")
    if not isinstance(permissions, (dict, list)):
        raise _bad_request("manifest.permissions must be an object or list")
    if isinstance(permissions, list):
        for it in permissions:
            if not isinstance(it, str) or it.strip() == "":
                raise _bad_request("manifest.permissions list items must be non-empty strings")

    manifest_canonical = _canonical_json(manifest_obj)
    permissions_canonical = _canonical_json(permissions)
    return pid, version, name, entry, permissions, permissions_canonical, manifest_canonical


@router.post(
    "",
    response_model=PluginUploadResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="plugins_upload_admin",
)
async def plugins_upload_admin(
    payload: PluginUploadRequest,
    db: Session = Depends(get_db),
    x_admin_secret: str | None = Header(None, alias="X-Admin-Secret"),
) -> PluginUploadResponse:
    _require_admin_secret(x_admin_secret)

    if payload.manifest_json.strip() == "":
        raise _bad_request("manifest_json must be non-empty")
    if payload.code == "":
        raise _bad_request("code must be non-empty")

    try:
        parsed = cast(object, json.loads(payload.manifest_json))
    except Exception as exc:
        raise _bad_request("manifest_json must be valid JSON") from exc

    plugin_id, version, name, entry, _perms_obj, perms_canonical, manifest_canonical = (
        _extract_manifest_fields(parsed)
    )
    sha256 = hashlib.sha256(payload.code.encode("utf-8")).hexdigest()

    now = datetime.utcnow()
    pkg = PluginPackage(
        plugin_id=plugin_id,
        version=version,
        name=name,
        entry=entry,
        permissions_json=perms_canonical,
        manifest_json=manifest_canonical,
        code_text=payload.code,
        sha256=sha256,
        status="pending",
        created_at=now,
        updated_at=now,
    )
    db.add(pkg)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Plugin package already exists",
        )

    db.commit()

    return PluginUploadResponse(
        id=pkg.plugin_id, version=pkg.version, status=pkg.status, sha256=pkg.sha256
    )


@router.get(
    "",
    response_model=list[PluginListItem],
    operation_id="plugins_list_approved",
)
async def plugins_list_approved(
    db: Session = Depends(get_db),
    _user_id: str = Depends(require_user_id),
) -> list[PluginListItem]:
    stmt = (
        select(PluginPackage)
        .where(PluginPackage.status == "approved")
        .order_by(PluginPackage.created_at.desc())
    )
    rows = cast(list[PluginPackage], db.execute(stmt).scalars().all())
    out: list[PluginListItem] = []
    for pkg in rows:
        try:
            perms: object = cast(object, json.loads(pkg.permissions_json))
        except Exception:
            perms = {}
        out.append(
            PluginListItem(
                id=pkg.plugin_id,
                version=pkg.version,
                name=pkg.name,
                sha256=pkg.sha256,
                permissions=perms,
            )
        )
    return out


@router.get(
    "/{plugin_id}/{version}",
    response_model=PluginDownloadResponse,
    operation_id="plugins_download_approved",
)
async def plugins_download_approved(
    plugin_id: str,
    version: str,
    db: Session = Depends(get_db),
    _user_id: str = Depends(require_user_id),
) -> PluginDownloadResponse:
    stmt = select(PluginPackage).where(
        PluginPackage.plugin_id == plugin_id,
        PluginPackage.version == version,
        PluginPackage.status == "approved",
    )
    pkg = db.execute(stmt).scalar_one_or_none()
    if pkg is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Plugin package not found"
        )

    return PluginDownloadResponse(
        manifest_json=pkg.manifest_json, code=pkg.code_text, sha256=pkg.sha256
    )
