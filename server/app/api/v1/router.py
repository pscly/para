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
