FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir "uv==0.5.16"

COPY server/pyproject.toml /app/pyproject.toml
COPY server/uv.lock /app/uv.lock
COPY server/README.md /app/README.md

COPY server/app /app/app
COPY server/alembic /app/alembic
COPY server/alembic.ini /app/alembic.ini

RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:${PATH}"

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
