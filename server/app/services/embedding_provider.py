from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import cast
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.admin_secrets import decrypt_secret
from app.db.models import AdminKV, AdminLLMChannel
from app.services.embedding_local import EMBED_DIM, EMBED_MODEL, local_embed


_FOLD_TAG = "fold64-v1"
_MIN_OPENAI_TIMEOUT_SECONDS = 1.0


@dataclass(frozen=True)
class EmbeddingResult:
    embedding: list[float]
    embedding_model: str
    embedding_dim: int


def embed_text(text: str, *, db: Session | None = None) -> EmbeddingResult:
    provider = settings.knowledge_embedding_provider.strip().lower()
    if provider == "local":
        return EmbeddingResult(
            embedding=local_embed(text, dim=EMBED_DIM),
            embedding_model=EMBED_MODEL,
            embedding_dim=EMBED_DIM,
        )
    if provider == "openai":
        raw, used_model = _openai_embed(text, db=db)
        folded = _fold_to_dim(raw, EMBED_DIM)
        model = _format_openai_embedding_model(used_model)
        return EmbeddingResult(
            embedding=folded,
            embedding_model=model,
            embedding_dim=EMBED_DIM,
        )
    raise RuntimeError(f"unknown embeddings provider: {provider!r}")


def _normalize_openai_base_url(raw: str) -> str:
    u = raw.strip()
    if u == "":
        raise ValueError("OPENAI_BASE_URL cannot be empty")
    p = urlparse(u)
    if not p.scheme or not p.netloc:
        raise ValueError("OPENAI_BASE_URL must be a full URL")
    u = u.rstrip("/")
    if not u.endswith("/v1"):
        u = u + "/v1"
    return u


def _format_openai_embedding_model(model_name: str) -> str:
    prefix = "openai:"
    suffix = f":{_FOLD_TAG}"
    raw = model_name.strip()
    if raw == "":
        raw = settings.openai_embeddings_model

    max_model_len = 50 - len(prefix) - len(suffix)
    if max_model_len <= 0:
        return (prefix + suffix)[:50]

    if len(raw) <= max_model_len:
        return prefix + raw + suffix

    fp = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
    keep = max_model_len - (1 + len(fp))
    head = raw[: max(0, keep)]
    return prefix + f"{head}~{fp}" + suffix


def _openai_embed(text: str, *, db: Session | None) -> tuple[list[float], str]:
    try:
        import httpx
    except Exception as e:
        raise RuntimeError("httpx is required for OpenAI embeddings") from e

    base_url, api_key, model, timeout_s = _resolve_openai_embeddings_config(db=db)

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "input": text}
    timeout = httpx.Timeout(timeout_s, connect=min(10.0, timeout_s))

    with httpx.Client(base_url=base_url, timeout=timeout, trust_env=False) as client:
        resp = client.post("embeddings", headers=headers, json=payload)
        _ = resp.raise_for_status()
        obj = cast(object, resp.json())

    if not isinstance(obj, dict):
        raise RuntimeError("unexpected embeddings response shape")

    obj_dict = cast(dict[str, object], obj)

    data_obj = obj_dict.get("data")
    if not isinstance(data_obj, list) or not data_obj:
        raise RuntimeError("embeddings response missing data")

    item0_raw = cast(object, data_obj[0])
    if not isinstance(item0_raw, dict):
        raise RuntimeError("embeddings response data[0] invalid")

    item0 = cast(dict[str, object], item0_raw)

    emb_obj = item0.get("embedding")
    if not isinstance(emb_obj, list):
        raise RuntimeError("embeddings response missing embedding")

    emb_list = cast(list[object], emb_obj)

    out: list[float] = []
    for v_raw in emb_list:
        if not isinstance(v_raw, (int, float)):
            raise RuntimeError("embeddings vector must be numeric")
        out.append(float(v_raw))
    return out, model


def _clamp_openai_timeout_seconds(raw: float | int | str | None) -> float:
    def _parse(v: float | int | str | None) -> float | None:
        if v is None:
            return None
        try:
            t = float(v)
        except Exception:
            return None
        if not math.isfinite(t) or t <= 0:
            return None
        return t

    t = (
        _parse(raw)
        or _parse(settings.openai_embeddings_timeout_seconds)
        or _MIN_OPENAI_TIMEOUT_SECONDS
    )
    return max(float(t), _MIN_OPENAI_TIMEOUT_SECONDS)


def _resolve_openai_embeddings_config(*, db: Session | None) -> tuple[str, str, str, float]:
    if db is not None:
        channel_id = _get_default_embedding_channel_id(db)
        if channel_id:
            ch = db.get(AdminLLMChannel, channel_id)
            if ch is not None and ch.enabled and ch.purpose == "embedding":
                if ch.api_key_enc:
                    try:
                        api_key = decrypt_secret(
                            ch.api_key_enc, key=settings.admin_secrets_master_key_bytes
                        ).strip()
                    except Exception as e:
                        raise RuntimeError("embedding channel api_key decryption failed") from e

                    if api_key != "":
                        try:
                            base_url = _normalize_openai_base_url(ch.base_url)
                        except Exception as e:
                            raise RuntimeError("embedding channel base_url invalid") from e

                        model = ch.default_model.strip() or settings.openai_embeddings_model
                        timeout_s = _clamp_openai_timeout_seconds(float(ch.timeout_ms) / 1000.0)
                        return base_url, api_key, model, timeout_s

    base_url_raw = settings.openai_base_url
    api_key_raw = settings.openai_api_key
    if base_url_raw and api_key_raw and base_url_raw.strip() and api_key_raw.strip():
        base_url = _normalize_openai_base_url(base_url_raw)
        api_key = api_key_raw.strip()
        model = settings.openai_embeddings_model
        timeout_s = _clamp_openai_timeout_seconds(settings.openai_embeddings_timeout_seconds)
        return base_url, api_key, model, timeout_s

    raise RuntimeError(
        "OpenAI embeddings enabled but no usable embedding channel routing and OPENAI_BASE_URL/OPENAI_API_KEY missing"
    )


def _get_default_embedding_channel_id(db: Session) -> str | None:
    row = (
        db.query(AdminKV)
        .filter(AdminKV.namespace == "llm_routing", AdminKV.key == "global")
        .one_or_none()
    )
    if row is None:
        return None
    try:
        obj = cast(object, json.loads(row.value_json))
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    raw = cast(dict[object, object], obj)
    val = raw.get("default_embedding_channel_id")
    return val if isinstance(val, str) and val.strip() else None


def _fold_to_dim(vec: list[float], out_dim: int) -> list[float]:
    if out_dim <= 0:
        raise ValueError("out_dim must be positive")

    out = [0.0] * out_dim
    if not vec:
        return out

    for i, v in enumerate(vec):
        out[i % out_dim] += float(v)
    return _l2_normalize(out)


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    if norm <= 0:
        return vec
    return [x / norm for x in vec]
