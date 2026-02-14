# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUntypedFunctionDecorator=false
# pyright: reportDeprecated=false
from __future__ import annotations

import base64
import hashlib
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.db.models import GalleryItem
from app.db.session import engine
from app.workers.celery_app import celery_app


_PNG_BASE64_VARIANTS: list[str] = [
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ekv7bYAAAAASUVORK5CYII=",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AAAAMBAQAY7w5gAAAAAElFTkSuQmCC",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58AAwMB/YnF7i8AAAAASUVORK5CYII=",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/xcAAwMB/UEKfWgAAAAASUVORK5CYII=",
]


def _pick_png_bytes(prompt: str) -> bytes:
    h = hashlib.sha256(prompt.encode("utf-8", errors="ignore")).digest()
    idx = h[0] % len(_PNG_BASE64_VARIANTS)
    return base64.b64decode(_PNG_BASE64_VARIANTS[idx])


@celery_app.task(name="app.workers.tasks.gallery.task_17_generate_gallery_image")
def task_17_generate_gallery_image(gallery_id: str) -> dict[str, object]:
    now = datetime.utcnow()
    with Session(engine) as db:
        item = db.get(GalleryItem, gallery_id)
        if item is None:
            return {"ok": False, "error": "gallery_item_not_found"}

        try:
            base_dir = Path(item.storage_dir)
            base_dir.mkdir(parents=True, exist_ok=True)

            image_path = base_dir / "image.png"
            thumb_path = base_dir / "thumb.png"

            png_bytes = _pick_png_bytes(item.prompt)
            _ = image_path.write_bytes(png_bytes)
            _ = thumb_path.write_bytes(png_bytes)

            item.status = "completed"
            item.error = None
            item.completed_at = now
            db.commit()

            return {
                "ok": True,
                "gallery_id": item.id,
                "save_id": item.save_id,
                "status": item.status,
            }
        except Exception as e:
            item.status = "failed"
            item.error = str(e)[:4000]
            db.commit()
            return {"ok": False, "gallery_id": item.id, "error": item.error}
