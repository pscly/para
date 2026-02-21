# para-server

FastAPI API server (uv + SQLAlchemy + Alembic).

The authoritative developer runbook lives at `docs/runbook.md`.

## Common commands

```bash
# migrations
cd server && uv run alembic upgrade head

# run API (multi-worker)
cd server && uv run uvicorn app.main:app --workers 2

# run tests
cd server && uv run pytest

# full local gate (contracts + server pytest + client lint/tests)
./scripts/ci.sh
```
