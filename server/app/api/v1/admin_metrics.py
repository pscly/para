# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.v1.admin_deps import get_current_admin_user
from app.db.models import AdminUser, AuditLog, LLMUsageEvent
from app.db.session import get_db


router = APIRouter(prefix="/admin/metrics", tags=["admin"])


@router.get(
    "/summary",
    operation_id="admin_metrics_summary",
)
async def metrics_summary(
    _admin: AdminUser = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    now = datetime.utcnow().replace(microsecond=0)
    since = now - timedelta(hours=24)

    audit_count = 0
    admin_count = 0
    llm_chat_count = 0
    llm_chat_error_count = 0
    llm_chat_interrupted_count = 0
    llm_latency_ms_avg = 0
    llm_latency_ms_p50 = 0
    llm_latency_ms_p95 = 0
    llm_ttft_ms_avg = 0
    llm_ttft_ms_p50 = 0
    llm_ttft_ms_p95 = 0
    llm_output_chunks_total = 0
    llm_output_chars_total = 0
    llm_prompt_tokens_total = 0
    llm_completion_tokens_total = 0
    llm_total_tokens_total = 0
    try:
        audit_count = int(
            db.execute(
                select(func.count()).select_from(AuditLog).where(AuditLog.created_at >= since)
            ).scalar_one()
        )
        admin_count = int(db.execute(select(func.count()).select_from(AdminUser)).scalar_one())

        usage_row = (
            db.execute(
                select(
                    func.count().label("cnt"),
                    func.coalesce(
                        func.sum(case((LLMUsageEvent.error.is_not(None), 1), else_=0)), 0
                    ).label("err_cnt"),
                    func.coalesce(
                        func.sum(case((LLMUsageEvent.interrupted.is_(True), 1), else_=0)), 0
                    ).label("inter_cnt"),
                    func.coalesce(func.avg(LLMUsageEvent.latency_ms), 0).label("lat_avg"),
                    func.percentile_cont(0.5)
                    .within_group(LLMUsageEvent.latency_ms.asc())
                    .label("lat_p50"),
                    func.percentile_cont(0.95)
                    .within_group(LLMUsageEvent.latency_ms.asc())
                    .label("lat_p95"),
                    func.coalesce(func.sum(LLMUsageEvent.output_chunks), 0).label("out_chunks"),
                    func.coalesce(func.sum(LLMUsageEvent.output_chars), 0).label("out_chars"),
                    func.coalesce(func.sum(func.coalesce(LLMUsageEvent.prompt_tokens, 0)), 0).label(
                        "tok_prompt"
                    ),
                    func.coalesce(
                        func.sum(func.coalesce(LLMUsageEvent.completion_tokens, 0)), 0
                    ).label("tok_completion"),
                    func.coalesce(func.sum(func.coalesce(LLMUsageEvent.total_tokens, 0)), 0).label(
                        "tok_total"
                    ),
                ).where(LLMUsageEvent.started_at >= since)
            )
            .mappings()
            .one()
        )

        ttft_row = (
            db.execute(
                select(
                    func.coalesce(func.avg(LLMUsageEvent.time_to_first_token_ms), 0).label(
                        "ttft_avg"
                    ),
                    func.percentile_cont(0.5)
                    .within_group(LLMUsageEvent.time_to_first_token_ms.asc())
                    .label("ttft_p50"),
                    func.percentile_cont(0.95)
                    .within_group(LLMUsageEvent.time_to_first_token_ms.asc())
                    .label("ttft_p95"),
                ).where(
                    LLMUsageEvent.started_at >= since,
                    LLMUsageEvent.time_to_first_token_ms.is_not(None),
                )
            )
            .mappings()
            .one()
        )

        llm_chat_count = int(usage_row.get("cnt") or 0)
        llm_chat_error_count = int(usage_row.get("err_cnt") or 0)
        llm_chat_interrupted_count = int(usage_row.get("inter_cnt") or 0)

        llm_latency_ms_avg = int(float(usage_row.get("lat_avg") or 0))
        llm_latency_ms_p50 = int(float(usage_row.get("lat_p50") or 0))
        llm_latency_ms_p95 = int(float(usage_row.get("lat_p95") or 0))

        llm_ttft_ms_avg = int(float(ttft_row.get("ttft_avg") or 0))
        llm_ttft_ms_p50 = int(float(ttft_row.get("ttft_p50") or 0))
        llm_ttft_ms_p95 = int(float(ttft_row.get("ttft_p95") or 0))

        llm_output_chunks_total = int(usage_row.get("out_chunks") or 0)
        llm_output_chars_total = int(usage_row.get("out_chars") or 0)
        llm_prompt_tokens_total = int(usage_row.get("tok_prompt") or 0)
        llm_completion_tokens_total = int(usage_row.get("tok_completion") or 0)
        llm_total_tokens_total = int(usage_row.get("tok_total") or 0)
    except Exception:
        audit_count = 0
        admin_count = 0
        llm_chat_count = 0
        llm_chat_error_count = 0
        llm_chat_interrupted_count = 0
        llm_latency_ms_avg = 0
        llm_latency_ms_p50 = 0
        llm_latency_ms_p95 = 0
        llm_ttft_ms_avg = 0
        llm_ttft_ms_p50 = 0
        llm_ttft_ms_p95 = 0
        llm_output_chunks_total = 0
        llm_output_chars_total = 0
        llm_prompt_tokens_total = 0
        llm_completion_tokens_total = 0
        llm_total_tokens_total = 0

    return {
        "generated_at": f"{now.isoformat()}Z",
        "audit_log_count_24h": audit_count,
        "admin_user_count": admin_count,
        "llm_chat_count_24h": llm_chat_count,
        "llm_chat_error_count_24h": llm_chat_error_count,
        "llm_chat_interrupted_count_24h": llm_chat_interrupted_count,
        "llm_chat_latency_ms_avg_24h": llm_latency_ms_avg,
        "llm_chat_latency_ms_p50_24h": llm_latency_ms_p50,
        "llm_chat_latency_ms_p95_24h": llm_latency_ms_p95,
        "llm_chat_ttft_ms_avg_24h": llm_ttft_ms_avg,
        "llm_chat_ttft_ms_p50_24h": llm_ttft_ms_p50,
        "llm_chat_ttft_ms_p95_24h": llm_ttft_ms_p95,
        "llm_chat_output_chunks_total_24h": llm_output_chunks_total,
        "llm_chat_output_chars_total_24h": llm_output_chars_total,
        "llm_chat_prompt_tokens_total_24h": llm_prompt_tokens_total,
        "llm_chat_completion_tokens_total_24h": llm_completion_tokens_total,
        "llm_chat_total_tokens_total_24h": llm_total_tokens_total,
    }
