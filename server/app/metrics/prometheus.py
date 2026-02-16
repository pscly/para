# pyright: reportMissingImports=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false
# pyright: reportAttributeAccessIssue=false

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LLMChatMetricLabels:
    provider: str
    api: str
    model: str


def _prom() -> object | None:
    try:
        import prometheus_client  # type: ignore

        return prometheus_client
    except Exception:
        return None


_PROM = _prom()

if _PROM is not None:
    Counter = _PROM.Counter
    Histogram = _PROM.Histogram
    generate_latest = _PROM.generate_latest
    CONTENT_TYPE_LATEST = _PROM.CONTENT_TYPE_LATEST
    REGISTRY = _PROM.REGISTRY

    _CHAT_REQUESTS = Counter(
        "para_llm_chat_stream_requests_total",
        "Total WS chat streams executed.",
        labelnames=("provider", "api", "model"),
    )
    _CHAT_ERRORS = Counter(
        "para_llm_chat_stream_errors_total",
        "Total WS chat streams that ended with error.",
        labelnames=("provider", "api", "model"),
    )
    _CHAT_INTERRUPTED = Counter(
        "para_llm_chat_stream_interrupted_total",
        "Total WS chat streams interrupted by client/connection.",
        labelnames=("provider", "api", "model"),
    )

    _CHAT_LATENCY = Histogram(
        "para_llm_chat_stream_latency_seconds",
        "End-to-end WS chat stream latency in seconds.",
        labelnames=("provider", "api", "model"),
    )
    _CHAT_TTFT = Histogram(
        "para_llm_chat_stream_ttft_seconds",
        "Time-to-first-token for WS chat streams in seconds.",
        labelnames=("provider", "api", "model"),
    )

    _OUT_CHUNKS = Counter(
        "para_llm_chat_stream_output_chunks_total",
        "Total output chunks emitted by WS chat streams.",
        labelnames=("provider", "api", "model"),
    )
    _OUT_CHARS = Counter(
        "para_llm_chat_stream_output_chars_total",
        "Total output chars emitted by WS chat streams.",
        labelnames=("provider", "api", "model"),
    )

    _TOK_PROMPT = Counter(
        "para_llm_chat_stream_prompt_tokens_total",
        "Total prompt tokens (when provider returns usage).",
        labelnames=("provider", "api", "model"),
    )
    _TOK_COMPLETION = Counter(
        "para_llm_chat_stream_completion_tokens_total",
        "Total completion tokens (when provider returns usage).",
        labelnames=("provider", "api", "model"),
    )
    _TOK_TOTAL = Counter(
        "para_llm_chat_stream_total_tokens_total",
        "Total tokens (when provider returns usage).",
        labelnames=("provider", "api", "model"),
    )


def record_llm_chat_stream(
    *,
    labels: LLMChatMetricLabels,
    latency_ms: int,
    ttft_ms: int | None,
    output_chunks: int,
    output_chars: int,
    interrupted: bool,
    error: str | None,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    total_tokens: int | None,
) -> None:
    if _PROM is None:
        return

    l = (labels.provider, labels.api, labels.model)

    _CHAT_REQUESTS.labels(*l).inc()
    if error is not None and error != "":
        _CHAT_ERRORS.labels(*l).inc()
    if interrupted:
        _CHAT_INTERRUPTED.labels(*l).inc()

    if latency_ms >= 0:
        _CHAT_LATENCY.labels(*l).observe(float(latency_ms) / 1000.0)
    if ttft_ms is not None and ttft_ms >= 0:
        _CHAT_TTFT.labels(*l).observe(float(ttft_ms) / 1000.0)

    if output_chunks > 0:
        _OUT_CHUNKS.labels(*l).inc(output_chunks)
    if output_chars > 0:
        _OUT_CHARS.labels(*l).inc(output_chars)

    if prompt_tokens is not None and prompt_tokens > 0:
        _TOK_PROMPT.labels(*l).inc(prompt_tokens)
    if completion_tokens is not None and completion_tokens > 0:
        _TOK_COMPLETION.labels(*l).inc(completion_tokens)
    if total_tokens is not None and total_tokens > 0:
        _TOK_TOTAL.labels(*l).inc(total_tokens)


def metrics_payload() -> tuple[bytes, str]:
    if _PROM is None:
        return b"", "text/plain; charset=utf-8"

    payload = generate_latest(REGISTRY)
    content_type = str(CONTENT_TYPE_LATEST)
    return payload, content_type
