# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportCallInDefaultInitializer=false
# pyright: reportDeprecated=false
from __future__ import annotations

import json
from datetime import datetime
from typing import cast

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AdminKV
from app.db.session import get_db


router = APIRouter(prefix="/feature_flags", tags=["feature_flags"])


def _default_feature_flags() -> dict[str, object]:
    return {"plugins_enabled": False, "invite_registration_enabled": True}


def _load_json_object(raw: str) -> dict[str, object]:
    try:
        val = cast(object, json.loads(raw))
    except Exception:
        return {}
    if isinstance(val, dict):
        return cast(dict[str, object], val)
    return {}


@router.get(
    "",
    operation_id="feature_flags_get",
)
async def get_feature_flags(
    db: Session = Depends(get_db),
) -> dict[str, object]:
    row = db.execute(
        select(AdminKV).where(AdminKV.namespace == "feature_flags", AdminKV.key == "global")
    ).scalar_one_or_none()

    flags = _default_feature_flags()
    if row is not None:
        loaded = _load_json_object(row.value_json)
        for k in list(flags.keys()):
            v = loaded.get(k)
            if isinstance(v, bool):
                flags[k] = v

    now = datetime.utcnow().replace(microsecond=0)
    return {"generated_at": f"{now.isoformat()}Z", "feature_flags": flags}
