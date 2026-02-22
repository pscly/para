# pyright: reportMissingImports=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownVariableType=false
from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.auth import router as auth_router
from app.api.v1.health import router as health_router
from app.api.v1.dreams import router as dreams_router
from app.api.v1.memory import router as memory_router
from app.api.v1.saves import router as saves_router
from app.api.v1.personas import router as personas_router
from app.api.v1.knowledge import router as knowledge_router
from app.api.v1.sensors import router as sensors_router
from app.api.v1.gallery import router as gallery_router
from app.api.v1.timeline import router as timeline_router
from app.api.v1.social import router as social_router
from app.api.v1.ugc import router as ugc_router
from app.api.v1.admin_review import router as admin_review_router
from app.api.v1.plugins import router as plugins_router
from app.api.v1.admin_auth import router as admin_auth_router
from app.api.v1.admin_config import router as admin_config_router
from app.api.v1.admin_llm import router as admin_llm_router
from app.api.v1.admin_metrics import router as admin_metrics_router
from app.api.v1.admin_invites import router as admin_invites_router
from app.api.v1.admin_users import router as admin_users_router
from app.api.v1.feature_flags import router as feature_flags_router


api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(health_router)
api_router.include_router(dreams_router)
api_router.include_router(memory_router)
api_router.include_router(saves_router)
api_router.include_router(personas_router)
api_router.include_router(knowledge_router)
api_router.include_router(sensors_router)
api_router.include_router(gallery_router)
api_router.include_router(timeline_router)
api_router.include_router(social_router)
api_router.include_router(ugc_router)
api_router.include_router(admin_review_router)
api_router.include_router(plugins_router)
api_router.include_router(admin_auth_router)
api_router.include_router(admin_config_router)
api_router.include_router(admin_llm_router)
api_router.include_router(admin_metrics_router)
api_router.include_router(admin_invites_router)
api_router.include_router(admin_users_router)
api_router.include_router(feature_flags_router)
