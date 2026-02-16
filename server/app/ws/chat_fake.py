from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol, cast
from urllib.parse import urlparse


@dataclass
class LLMStreamCapture:
    provider: str = "fake"
    api: str = "fake"
    model: str = "fake"

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


async def fake_chat_tokens(text: str) -> AsyncIterator[str]:
    reply = f"AI: {text}"
    for ch in reply:
        await asyncio.sleep(0)
        yield ch


def _env_str(name: str) -> str | None:
    v = os.environ.get(name)
    if v is None:
        return None
    v = v.strip()
    return v if v != "" else None


def _normalize_openai_base_url(raw: str) -> str:
    u = raw.strip()
    if u == "":
        raise ValueError("OPENAI_BASE_URL 不能为空")
    p = urlparse(u)
    if not p.scheme or not p.netloc:
        raise ValueError(
            "OPENAI_BASE_URL 必须是完整 URL（例如 http://127.0.0.1:1234 或 https://...）"
        )
    u = u.rstrip("/")
    if not u.endswith("/v1"):
        u = u + "/v1"
    return u


class _SSELineStream(Protocol):
    def aiter_lines(self) -> AsyncIterator[str]: ...


async def _iter_sse_data(resp: _SSELineStream) -> AsyncIterator[str]:
    buf: list[str] = []
    async for line in resp.aiter_lines():
        line = str(line)

        if line == "":
            if buf:
                yield "\n".join(buf)
                buf = []
            continue

        if line.startswith(":"):
            continue

        if line.startswith("data:"):
            buf.append(line[len("data:") :].lstrip())
            continue

        continue

    if buf:
        yield "\n".join(buf)


def _extract_openai_delta_from_responses(obj: dict[str, object]) -> str | None:
    typ = obj.get("type")
    if typ == "response.output_text.delta":
        delta = obj.get("delta")
        return delta if isinstance(delta, str) and delta != "" else None
    if typ == "response.output_text.done":
        return None
    delta2 = obj.get("delta")
    if isinstance(delta2, str) and delta2 != "":
        return delta2
    return None


def _extract_openai_delta_from_chat_completions(obj: dict[str, object]) -> str | None:
    choices_obj = obj.get("choices")
    if not isinstance(choices_obj, list) or not choices_obj:
        return None
    c0_raw = cast(object, choices_obj[0])
    if not isinstance(c0_raw, dict):
        return None
    c0 = cast(dict[str, object], c0_raw)
    delta_raw = c0.get("delta")
    if not isinstance(delta_raw, dict):
        return None
    delta = cast(dict[str, object], delta_raw)
    content_obj = delta.get("content")
    return content_obj if isinstance(content_obj, str) and content_obj != "" else None


def _maybe_capture_usage_from_obj(obj: dict[str, object], capture: LLMStreamCapture | None) -> None:
    if capture is None:
        return

    usage: dict[str, object] | None = None
    usage_top = obj.get("usage")
    if isinstance(usage_top, dict):
        usage = cast(dict[str, object], usage_top)
    else:
        resp_raw = obj.get("response")
        if isinstance(resp_raw, dict):
            resp = cast(dict[str, object], resp_raw)
            usage_nested = resp.get("usage")
            if isinstance(usage_nested, dict):
                usage = cast(dict[str, object], usage_nested)

    if usage is None:
        return

    prompt_obj = usage.get("prompt_tokens")
    completion_obj = usage.get("completion_tokens")
    total_obj = usage.get("total_tokens")

    if not isinstance(prompt_obj, int):
        prompt_obj = usage.get("input_tokens")
    if not isinstance(completion_obj, int):
        completion_obj = usage.get("output_tokens")

    prompt = prompt_obj if isinstance(prompt_obj, int) and prompt_obj >= 0 else None
    completion = completion_obj if isinstance(completion_obj, int) and completion_obj >= 0 else None
    total = total_obj if isinstance(total_obj, int) and total_obj >= 0 else None

    if total is None and prompt is not None and completion is not None:
        total = int(prompt + completion)

    if prompt is not None:
        capture.prompt_tokens = int(prompt)
    if completion is not None:
        capture.completion_tokens = int(completion)
    if total is not None:
        capture.total_tokens = int(total)


async def _openai_stream_tokens_via_responses(
    *,
    base_url: str,
    api_key: str,
    model: str,
    text: str,
    stop: asyncio.Event,
    capture: LLMStreamCapture | None,
) -> AsyncIterator[str]:
    try:
        import httpx
    except Exception as e:
        raise RuntimeError(
            "openai streaming 需要运行时依赖 httpx；请在 server/pyproject.toml 安装 httpx"
        ) from e

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "input": text, "stream": True}

    timeout = httpx.Timeout(60.0, connect=10.0)
    async with httpx.AsyncClient(base_url=base_url, timeout=timeout, trust_env=False) as client:
        if stop.is_set():
            return

        async with client.stream("POST", "responses", headers=headers, json=payload) as resp:
            _ = resp.raise_for_status()
            async for data in _iter_sse_data(resp):
                if stop.is_set():
                    return
                if data.strip() == "[DONE]":
                    return
                try:
                    obj = cast(object, json.loads(data))
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                obj_dict = cast(dict[str, object], obj)
                _maybe_capture_usage_from_obj(obj_dict, capture)
                delta = _extract_openai_delta_from_responses(obj_dict)
                if delta is None:
                    continue
                yield delta


async def _openai_stream_tokens_via_chat_completions(
    *,
    base_url: str,
    api_key: str,
    model: str,
    text: str,
    stop: asyncio.Event,
    capture: LLMStreamCapture | None,
) -> AsyncIterator[str]:
    try:
        import httpx
    except Exception as e:
        raise RuntimeError(
            "openai streaming 需要运行时依赖 httpx；请在 server/pyproject.toml 安装 httpx"
        ) from e

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": text}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    timeout = httpx.Timeout(60.0, connect=10.0)
    async with httpx.AsyncClient(base_url=base_url, timeout=timeout, trust_env=False) as client:
        if stop.is_set():
            return

        async with client.stream("POST", "chat/completions", headers=headers, json=payload) as resp:
            _ = resp.raise_for_status()
            async for data in _iter_sse_data(resp):
                if stop.is_set():
                    return
                if data.strip() == "[DONE]":
                    return
                try:
                    obj = cast(object, json.loads(data))
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                obj_dict = cast(dict[str, object], obj)
                _maybe_capture_usage_from_obj(obj_dict, capture)
                delta = _extract_openai_delta_from_chat_completions(obj_dict)
                if delta is None:
                    continue
                yield delta


async def stream_chat_tokens(
    text: str,
    *,
    stop: asyncio.Event | None = None,
    capture: LLMStreamCapture | None = None,
) -> AsyncIterator[str]:
    stop_event = stop or asyncio.Event()

    mode = (_env_str("OPENAI_MODE") or "fake").lower()
    if mode != "openai":
        if capture is not None:
            capture.provider = "fake"
            capture.api = "fake"
            capture.model = "fake"
        async for t in fake_chat_tokens(text):
            if stop_event.is_set():
                return
            yield t
        return

    base_url = _env_str("OPENAI_BASE_URL")
    api_key = _env_str("OPENAI_API_KEY")
    model = _env_str("OPENAI_MODEL")
    api = (_env_str("OPENAI_API") or "auto").lower()

    if capture is not None:
        capture.provider = "openai_compatible"
        capture.model = str(model or "")

    if not base_url or not api_key or not model:
        raise RuntimeError(
            "OPENAI_MODE=openai 需要同时配置 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL"
        )

    base_url = _normalize_openai_base_url(base_url)

    if api in ("responses", "response"):
        if capture is not None:
            capture.api = "responses"
        async for t in _openai_stream_tokens_via_responses(
            base_url=base_url,
            api_key=api_key,
            model=model,
            text=text,
            stop=stop_event,
            capture=capture,
        ):
            yield t
        return

    if api in ("chat", "chat_completions", "chat.completions"):
        if capture is not None:
            capture.api = "chat_completions"
        async for t in _openai_stream_tokens_via_chat_completions(
            base_url=base_url,
            api_key=api_key,
            model=model,
            text=text,
            stop=stop_event,
            capture=capture,
        ):
            yield t
        return

    try:
        if capture is not None:
            capture.api = "responses"
        async for t in _openai_stream_tokens_via_responses(
            base_url=base_url,
            api_key=api_key,
            model=model,
            text=text,
            stop=stop_event,
            capture=capture,
        ):
            yield t
        return
    except Exception as e:
        status_code = getattr(getattr(e, "response", None), "status_code", None)
        if isinstance(status_code, int) and status_code not in (400, 404, 405):
            raise
        if capture is not None:
            capture.api = "chat_completions"
        async for t in _openai_stream_tokens_via_chat_completions(
            base_url=base_url,
            api_key=api_key,
            model=model,
            text=text,
            stop=stop_event,
            capture=capture,
        ):
            yield t
        return
