# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false

from __future__ import annotations

import base64
import binascii
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import app.ws.v1 as ws_v1
from app.api.v1.saves import require_user_id
from app.core.security import JSONValue
from app.db.models import Save
from app.db.session import get_db


router = APIRouter(prefix="/sensors", tags=["sensors"])


MAX_SCREENSHOT_BYTES = 256 * 1024
MAX_SCREENSHOT_B64_CHARS = 360 * 1024


class ScreenshotRequest(BaseModel):
    save_id: str = Field(..., min_length=1)
    image_base64: str = Field(..., min_length=1)

    privacy_mode: Literal["strict", "standard"] = Field(
        "strict",
        description=(
            "strict: only return suggestion; standard: also append WS SUGGESTION event (no screenshot content)"
        ),
    )
    emit_ws_event: bool | None = Field(
        None,
        description="Override privacy_mode default WS behavior",
    )


class ScreenshotResponse(BaseModel):
    suggestion: str


class SensorEventRequest(BaseModel):
    save_id: str = Field(..., min_length=1)
    event_type: Literal["clipboard", "idle"]
    text: str | None = None
    idle_seconds: int | None = Field(None, ge=0)
    app_name: str | None = None


class SensorEventResponse(BaseModel):
    suggestion: str = Field(..., min_length=1)
    category: Literal["translation", "care", "generic"]


def _get_owned_save_or_404(db: Session, *, user_id: str, save_id: str) -> Save:
    save = db.get(Save, save_id)
    if save is None or save.user_id != user_id or save.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Save not found")
    return save


def _strip_data_url_prefix(b64: str) -> str:
    if "," in b64 and "base64" in b64[:64].lower():
        return b64.split(",", 1)[1]
    return b64


def _png_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24:
        return None
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    if data[12:16] != b"IHDR":
        return None
    w = int.from_bytes(data[16:20], "big", signed=False)
    h = int.from_bytes(data[20:24], "big", signed=False)
    if w <= 0 or h <= 0:
        return None
    return (w, h)


def _make_suggestion(*, dims: tuple[int, int] | None) -> str:
    if dims is None:
        return "已收到截图。建议：请告诉我你想让我关注的区域（按钮/报错/表单字段等）以及你的目标。"
    w, h = dims
    return f"已收到 {w}x{h} 的截图。建议：请描述你要我重点关注的区域（例如左上角菜单/弹窗报错/某个按钮）并说明你的目标。"


def _looks_like_english(text: str) -> bool:
    t = text.strip()
    if t == "":
        return False
    if len(t) < 8:
        return False

    total = len(t)
    letters = 0
    spaces = 0
    for ch in t:
        if ch.isspace():
            spaces += 1
            continue
        if ch.isascii() and ch.isalpha():
            letters += 1

    if letters < 4:
        return False
    if letters / total < 0.25:
        return False

    space_ratio = spaces / total
    if not (0.05 <= space_ratio <= 0.6):
        return False

    return True


def _make_event_suggestion(payload: SensorEventRequest) -> SensorEventResponse:
    if payload.event_type == "idle":
        suggestion = (
            "你刚刚有一段时间没操作了，要不要喝口水/伸个懒腰？需要我帮你继续刚才的事也可以。"
        )
        return SensorEventResponse(suggestion=suggestion, category="care")

    text = (payload.text or "").strip()
    if text != "" and _looks_like_english(text):
        suggestion = "我看到了英文内容，要不要我帮你翻译一下，或者做个一句话总结？"
        return SensorEventResponse(suggestion=suggestion, category="translation")

    suggestion = "我看到你复制了内容，需要我帮你整理、总结，或者把它写成待办/笔记吗？"
    return SensorEventResponse(suggestion=suggestion, category="generic")


@router.post(
    "/screenshot",
    response_model=ScreenshotResponse,
    operation_id="sensors_screenshot",
)
async def sensors_screenshot(
    payload: ScreenshotRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> ScreenshotResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=payload.save_id)

    raw_b64 = _strip_data_url_prefix(payload.image_base64).strip()
    if len(raw_b64) > MAX_SCREENSHOT_B64_CHARS:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Screenshot payload too large",
        )

    try:
        img_bytes = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid screenshot"
        )

    if len(img_bytes) > MAX_SCREENSHOT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Screenshot payload too large",
        )

    dims = _png_dimensions(img_bytes)
    suggestion = _make_suggestion(dims=dims)

    should_emit = (
        bool(payload.emit_ws_event)
        if payload.emit_ws_event is not None
        else payload.privacy_mode == "standard"
    )
    if should_emit:
        ws_payload: JSONValue = {
            "source": "vision",
            "suggestion": suggestion,
            "meta": {
                "bytes": len(img_bytes),
                "width": dims[0] if dims else None,
                "height": dims[1] if dims else None,
            },
        }
        try:
            _ = ws_v1.append_typed_event(
                (user_id, payload.save_id),
                frame_type="SUGGESTION",
                payload=ws_payload,
                ack_required=True,
            )
        except Exception:
            pass

    return ScreenshotResponse(suggestion=suggestion)


@router.post(
    "/event",
    response_model=SensorEventResponse,
    operation_id="sensors_event",
)
async def sensors_event(
    payload: SensorEventRequest,
    db: Session = Depends(get_db),
    user_id: str = Depends(require_user_id),
) -> SensorEventResponse:
    _ = _get_owned_save_or_404(db, user_id=user_id, save_id=payload.save_id)
    return _make_event_suggestion(payload)
