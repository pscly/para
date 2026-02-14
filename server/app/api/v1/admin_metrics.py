# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v1.admin_deps import get_current_admin_user
from app.db.models import AdminUser, AuditLog
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
    try:
        audit_count = int(
            db.execute(
                select(func.count()).select_from(AuditLog).where(AuditLog.created_at >= since)
            ).scalar_one()
        )
        admin_count = int(db.execute(select(func.count()).select_from(AdminUser)).scalar_one())
    except Exception:
        audit_count = 0
        admin_count = 0

    return {
        "generated_at": f"{now.isoformat()}Z",
        "audit_log_count_24h": audit_count,
        "admin_user_count": admin_count,
    }
