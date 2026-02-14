from __future__ import annotations

import hashlib
import math


EMBED_DIM = 64
EMBED_MODEL = "local-hash-v1"


def local_embed(text_in: str, *, dim: int = EMBED_DIM) -> list[float]:
    text_norm = text_in.strip()
    vec = [0.0] * dim
    if text_norm == "":
        return vec

    for ch in text_norm:
        if ch.isspace():
            continue
        h = hashlib.sha256(ch.encode("utf-8")).digest()
        idx = int.from_bytes(h[:4], "big") % dim
        vec[idx] += 1.0

    norm = math.sqrt(sum(x * x for x in vec))
    if norm > 0:
        vec = [x / norm for x in vec]
    return vec
