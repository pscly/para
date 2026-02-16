from __future__ import annotations

import math
from dataclasses import dataclass
from typing import cast
from urllib.parse import urlparse

from app.core.config import settings
from app.services.embedding_local import EMBED_DIM, EMBED_MODEL, local_embed


_FOLD_TAG = "fold64-v1"


@dataclass(frozen=True)
class EmbeddingResult:
    embedding: list[float]
    embedding_model: str
    embedding_dim: int


def embed_text(text: str) -> EmbeddingResult:
    provider = settings.knowledge_embedding_provider.strip().lower()
    if provider == "local":
        return EmbeddingResult(
            embedding=local_embed(text, dim=EMBED_DIM),
            embedding_model=EMBED_MODEL,
            embedding_dim=EMBED_DIM,
        )
    if provider == "openai":
        raw = _openai_embed(text)
        folded = _fold_to_dim(raw, EMBED_DIM)
        model = f"openai:{settings.openai_embeddings_model}:{_FOLD_TAG}"
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


def _openai_embed(text: str) -> list[float]:
    try:
        import httpx
    except Exception as e:
        raise RuntimeError("httpx is required for OpenAI embeddings") from e

    base_url_raw = settings.openai_base_url
    api_key_raw = settings.openai_api_key
    if not base_url_raw or not api_key_raw:
        raise RuntimeError("OpenAI embeddings enabled but OPENAI_BASE_URL/OPENAI_API_KEY missing")

    base_url = _normalize_openai_base_url(base_url_raw)
    api_key = api_key_raw.strip()
    model = settings.openai_embeddings_model

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "input": text}
    timeout_s = float(settings.openai_embeddings_timeout_seconds)
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
    return out


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
