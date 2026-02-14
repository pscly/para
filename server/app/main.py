from __future__ import annotations

import uuid

from fastapi import FastAPI, Request, Response
from starlette.middleware.base import RequestResponseEndpoint

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.logging import configure_logging, request_id_ctx_var
from app.ws.v1 import router as ws_v1_router


configure_logging(settings.log_level)

app = FastAPI(title="para-server")


@app.middleware("http")
async def request_id_middleware(request: Request, call_next: RequestResponseEndpoint) -> Response:
    rid = request.headers.get("X-Request-Id") or uuid.uuid4().hex
    token = request_id_ctx_var.set(rid)
    try:
        response = await call_next(request)
    finally:
        request_id_ctx_var.reset(token)

    response.headers["X-Request-Id"] = rid
    return response


app.include_router(api_router, prefix=settings.api_v1_prefix)
app.include_router(ws_v1_router)
