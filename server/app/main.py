# pyright: reportUnusedFunction=false

from __future__ import annotations

import uuid

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import RequestResponseEndpoint
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.v1.router import api_router
from app.core.config import Settings, get_settings, settings
from app.core.version import get_app_version
from app.core.logging import configure_logging, request_id_ctx_var
from app.ws.v1 import router as ws_v1_router


def create_app(app_settings: Settings | None = None) -> FastAPI:
    s = app_settings or get_settings()

    configure_logging(s.log_level)

    app_version = get_app_version()
    app = FastAPI(title="para-server", version=app_version)

    if s.para_appenc_enabled:
        from app.middleware.app_encryption import AppEncryptionMiddleware

        app.add_middleware(AppEncryptionMiddleware, settings=s)

    if s.trusted_hosts:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=s.trusted_hosts)

    if s.cors_allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=s.cors_allowed_origins,
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
            max_age=600,
        )

    @app.middleware("http")
    async def request_context_and_security_headers(
        request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        rid = request.headers.get("X-Request-Id") or uuid.uuid4().hex
        token = request_id_ctx_var.set(rid)
        try:
            response = await call_next(request)
        finally:
            request_id_ctx_var.reset(token)

        response.headers["X-Request-Id"] = rid
        response.headers["X-Para-Version"] = app_version
        _ = response.headers.setdefault("X-Content-Type-Options", "nosniff")
        _ = response.headers.setdefault("X-Frame-Options", "DENY")
        _ = response.headers.setdefault("Referrer-Policy", "no-referrer")
        _ = response.headers.setdefault(
            "Permissions-Policy",
            "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
        )
        return response

    app.include_router(api_router, prefix=s.api_v1_prefix)
    app.include_router(ws_v1_router)

    @app.get("/metrics", include_in_schema=False)
    async def prometheus_metrics() -> Response:
        from app.metrics.prometheus import metrics_payload

        payload, content_type = metrics_payload()
        return Response(content=payload, media_type=content_type)

    return app


app = create_app(settings)


__all__ = ["app", "create_app"]
