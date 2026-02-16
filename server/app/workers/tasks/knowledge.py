# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUntypedFunctionDecorator=false
# pyright: reportDeprecated=false
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.db.models import KnowledgeChunk, KnowledgeMaterial
from app.db.session import engine
from app.services.embedding_provider import embed_text
from app.workers.celery_app import celery_app


def _read_text_file(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _read_pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except Exception as e:
        raise RuntimeError(f"PDF parsing dependency missing: {e}")

    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        raw = page.extract_text()
        txt = raw or ""
        if txt:
            parts.append(txt)
    return "\n\n".join(parts).strip()


def _chunk_text(text_in: str, *, max_chars: int = 800, overlap: int = 120) -> list[str]:
    text_norm = text_in.replace("\r\n", "\n").replace("\r", "\n")
    text_norm = "\n".join(line.rstrip() for line in text_norm.split("\n")).strip()
    if text_norm == "":
        return []

    n = len(text_norm)
    chunks: list[str] = []
    start = 0
    while start < n:
        end = min(n, start + max_chars)
        window = text_norm[start:end]

        cut = end
        min_cut = start + max(200, int(max_chars * 0.5))
        if end - start >= 250:
            seps = ["\n\n", "\n", ". ", "。", "! ", "? ", "; ", "；", ", ", "，"]
            for sep in seps:
                pos = window.rfind(sep)
                if pos != -1:
                    candidate = start + pos + len(sep)
                    if candidate >= min_cut:
                        cut = candidate
                        break

        if cut <= start:
            cut = end

        chunk = text_norm[start:cut].strip()
        if chunk:
            chunks.append(chunk)

        if cut >= n:
            break

        next_start = cut - overlap
        if next_start <= start:
            next_start = cut
        start = next_start

    return chunks


@celery_app.task(name="app.workers.tasks.knowledge.task_13_index_knowledge_material")
def task_13_index_knowledge_material(material_id: str) -> dict[str, object]:
    now = datetime.utcnow()
    with Session(engine) as db:
        material = db.get(KnowledgeMaterial, material_id)
        if material is None:
            return {"ok": False, "error": "material_not_found"}

        material.status = "pending"
        material.error = None
        db.commit()

        try:
            path = Path(material.storage_path)
            suffix = path.suffix.lower()
            if suffix in {".md", ".txt"}:
                full_text = _read_text_file(path)
            elif suffix == ".pdf":
                full_text = _read_pdf_text(path)
            else:
                raise ValueError(f"unsupported material type: {suffix}")

            chunks = _chunk_text(full_text)
            _ = db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.material_id == material.id))
            db.commit()

            for idx, content in enumerate(chunks):
                emb = embed_text(content)
                db.add(
                    KnowledgeChunk(
                        material_id=material.id,
                        save_id=material.save_id,
                        chunk_index=idx,
                        content=content,
                        embedding_model=emb.embedding_model,
                        embedding_dim=int(emb.embedding_dim),
                        embedding=emb.embedding,
                        created_at=now,
                    )
                )

            material.status = "indexed"
            material.updated_at = now
            db.commit()

            return {
                "ok": True,
                "material_id": material.id,
                "save_id": material.save_id,
                "chunk_count": len(chunks),
            }
        except Exception as e:
            material.status = "failed"
            material.error = str(e)[:4000]
            material.updated_at = now
            db.commit()
            return {"ok": False, "material_id": material.id, "error": material.error}
