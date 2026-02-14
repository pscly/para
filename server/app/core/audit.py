from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db.models import AuditLog


def purge_old_audit_logs(
    db: Session,
    *,
    now: datetime,
    retention_days: int,
) -> dict[str, object]:
    retention_days = int(retention_days)
    cutoff = now - timedelta(days=retention_days)

    to_delete = db.execute(
        select(func.count()).select_from(AuditLog).where(AuditLog.created_at < cutoff)
    ).scalar_one()
    _ = db.execute(delete(AuditLog).where(AuditLog.created_at < cutoff))
    db.commit()

    return {
        "deleted": int(to_delete),
        "retention_days": retention_days,
        "cutoff": cutoff.isoformat(),
    }
