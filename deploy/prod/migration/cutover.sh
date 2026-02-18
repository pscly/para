#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/prod/migration/cutover.sh [--help] [--dry-run] [--run]
                                       [--timestamp <YYYYmmddHHMMSS>]
                                       [--app-root <dir>] [--env-file <path>]
                                       [--compose-file <path>] [--project-name <name>]
                                       [--prod-base-url <url>] [--ws-base <url>]
                                       [--src-dump <path>] [--src-assets <path>]
                                       [--freeze] [--backup] [--migrate] [--up] [--health]
                                       [--smoke-core]
                                       [--restore-assets] [--restore-db]
                                       [--i-know-what-im-doing]

Goal:
  Provide a safe, executable helper for the production cutover runbook.

Defaults:
  - Plan-only by default (equivalent to --dry-run).
  - Evidence is written to /root/dockers/para/backups/evidence/task-17/<timestamp>/

Notes:
  - This script never prints secrets.
  - It does not SSH or fetch artifacts. You must place source artifacts on the server first.
  - Destructive steps are gated behind --i-know-what-im-doing.

Examples:
  # Show plan
  bash deploy/prod/migration/cutover.sh --dry-run --freeze --backup --migrate --up --health

  # Execute safe steps (still non-destructive): freeze + baseline backup + migrate + up + health
  bash deploy/prod/migration/cutover.sh --run --freeze --backup --migrate --up --health \
    --prod-base-url "https://<prod-domain>"

  # Execute destructive restore steps (requires explicit opt-in)
  bash deploy/prod/migration/cutover.sh --run --restore-assets --restore-db --i-know-what-im-doing \
    --src-assets "/root/dockers/para/backups/evidence/task-17/<ts>/src_artifacts/para.src.data.tar.gz" \
    --src-dump   "/root/dockers/para/backups/evidence/task-17/<ts>/src_artifacts/para.src.dump"
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing_required_command=$1"
}

dry_run=1

APP_ROOT="/root/dockers/para/app"
ENV_FILE="/root/dockers/para/.env"
COMPOSE_FILE="deploy/prod/docker-compose.yml"
COMPOSE_PROJECT="para"

BACKUP_ROOT="/root/dockers/para/backups"
TS=""

PROD_BASE_URL=""
WS_BASE=""

SRC_DUMP_FILE=""
SRC_ASSETS_TAR=""

do_freeze=0
do_backup=0
do_restore_assets=0
do_restore_db=0
do_migrate=0
do_up=0
do_health=0
do_smoke_core=0

i_know=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --run)
      dry_run=0
      shift
      ;;
    --timestamp)
      TS="${2:-}"
      [[ -n "$TS" ]] || die "missing_value_for=--timestamp"
      shift 2
      ;;
    --app-root)
      APP_ROOT="${2:-}"
      [[ -n "$APP_ROOT" ]] || die "missing_value_for=--app-root"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      [[ -n "$ENV_FILE" ]] || die "missing_value_for=--env-file"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:-}"
      [[ -n "$COMPOSE_FILE" ]] || die "missing_value_for=--compose-file"
      shift 2
      ;;
    --project-name)
      COMPOSE_PROJECT="${2:-}"
      [[ -n "$COMPOSE_PROJECT" ]] || die "missing_value_for=--project-name"
      shift 2
      ;;
    --prod-base-url)
      PROD_BASE_URL="${2:-}"
      [[ -n "$PROD_BASE_URL" ]] || die "missing_value_for=--prod-base-url"
      shift 2
      ;;
    --ws-base)
      WS_BASE="${2:-}"
      [[ -n "$WS_BASE" ]] || die "missing_value_for=--ws-base"
      shift 2
      ;;
    --src-dump)
      SRC_DUMP_FILE="${2:-}"
      [[ -n "$SRC_DUMP_FILE" ]] || die "missing_value_for=--src-dump"
      shift 2
      ;;
    --src-assets)
      SRC_ASSETS_TAR="${2:-}"
      [[ -n "$SRC_ASSETS_TAR" ]] || die "missing_value_for=--src-assets"
      shift 2
      ;;
    --freeze)
      do_freeze=1
      shift
      ;;
    --backup)
      do_backup=1
      shift
      ;;
    --restore-assets)
      do_restore_assets=1
      shift
      ;;
    --restore-db)
      do_restore_db=1
      shift
      ;;
    --migrate)
      do_migrate=1
      shift
      ;;
    --up)
      do_up=1
      shift
      ;;
    --health)
      do_health=1
      shift
      ;;
    --smoke-core)
      do_smoke_core=1
      shift
      ;;
    --i-know-what-im-doing)
      i_know=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      die "unknown_arg=$1"
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  die "unexpected_extra_args=$*"
fi

need_cmd docker
docker compose version >/dev/null 2>&1 || die "docker_compose_not_available=1"
need_cmd date
need_cmd mkdir
need_cmd tar
need_cmd curl
need_cmd python3

if [[ -z "$TS" ]]; then
  TS="$(date +%Y%m%d%H%M%S)"
fi

EVIDENCE_DIR="$BACKUP_ROOT/evidence/task-17/$TS"
LOG_DIR="$EVIDENCE_DIR/logs"
OUT_DIR="$EVIDENCE_DIR/outputs"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" "$@"
}

run_cmd() {
  local display="$1"
  shift
  printf '+ %s\n' "$display"
  if (( dry_run == 1 )); then
    return 0
  fi
  "$@"
}

compose_ps_to_file() {
  local out="$1"
  compose ps >"$out"
}

curl_to_file() {
  local url="$1"
  local out="$2"
  curl -fsS "$url" >"$out"
}

backup_pg_dump_to_log() {
  TIMESTAMP="$TS" bash deploy/prod/backup/backup_pg_dump.sh --env-file "$ENV_FILE" >"$LOG_DIR/backup_pg_dump.txt" 2>&1
}

backup_assets_to_log() {
  TIMESTAMP="$TS" bash deploy/prod/backup/backup_assets.sh >"$LOG_DIR/backup_assets.txt" 2>&1
}

migrate_to_log() {
  compose --profile migrate run --rm migrate >"$LOG_DIR/alembic-upgrade.txt" 2>&1
}

copy_dump_into_postgres() {
  compose exec -T postgres sh -c 'cat > /tmp/para.src.dump' <"$SRC_DUMP_FILE"
}

pg_reset_public_schema_to_log() {
  compose exec -T postgres sh -c 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-para}" -d "${POSTGRES_DB:-para}" -c "DROP SCHEMA public CASCADE;" -c "CREATE SCHEMA public;"' >"$LOG_DIR/pg_reset_schema.txt" 2>&1
}

pg_restore_to_log() {
  compose exec -T postgres sh -c 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; pg_restore --no-owner --no-acl --exit-on-error -U "${POSTGRES_USER:-para}" -d "${POSTGRES_DB:-para}" /tmp/para.src.dump' >"$LOG_DIR/pg_restore.txt" 2>&1
}

ensure_evidence_dirs() {
  run_cmd "mkdir -p '$LOG_DIR' '$OUT_DIR' '$EVIDENCE_DIR/src_artifacts'" \
    mkdir -p "$LOG_DIR" "$OUT_DIR" "$EVIDENCE_DIR/src_artifacts"
}

require_i_know() {
  local action="$1"
  if (( i_know != 1 )); then
    die "refusing_destructive_action=${action} (add --i-know-what-im-doing)"
  fi
}

preflight() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die "env_file_missing=$ENV_FILE"
  fi
  if [[ ! -d "$APP_ROOT" ]]; then
    die "app_root_missing=$APP_ROOT"
  fi
}

step_freeze() {
  ensure_evidence_dirs
  run_cmd "cd '$APP_ROOT'" cd "$APP_ROOT"
  run_cmd "compose ps > '$OUT_DIR/compose-ps.before.txt'" compose_ps_to_file "$OUT_DIR/compose-ps.before.txt"
  run_cmd "compose stop api worker beat" compose stop api worker beat || true
  run_cmd "compose ps > '$OUT_DIR/compose-ps.frozen.txt'" compose_ps_to_file "$OUT_DIR/compose-ps.frozen.txt"
}

step_backup() {
  ensure_evidence_dirs
  run_cmd "cd '$APP_ROOT'" cd "$APP_ROOT"

  run_cmd "TIMESTAMP='$TS' bash deploy/prod/backup/backup_pg_dump.sh --env-file '$ENV_FILE' > '$LOG_DIR/backup_pg_dump.txt'" \
    backup_pg_dump_to_log

  run_cmd "TIMESTAMP='$TS' bash deploy/prod/backup/backup_assets.sh > '$LOG_DIR/backup_assets.txt'" \
    backup_assets_to_log
}

step_restore_assets() {
  require_i_know "restore_assets"
  ensure_evidence_dirs
  run_cmd "cd '$APP_ROOT'" cd "$APP_ROOT"

  if [[ -z "$SRC_ASSETS_TAR" ]]; then
    SRC_ASSETS_TAR="$EVIDENCE_DIR/src_artifacts/para.src.data.tar.gz"
  fi
  if (( dry_run == 0 )) && [[ ! -f "$SRC_ASSETS_TAR" ]]; then
    die "src_assets_tar_missing=$SRC_ASSETS_TAR"
  fi

  local tmp_extract="$EVIDENCE_DIR/tmp/assets_extract"
  local assets_dst="/root/dockers/para/data/server/.data"

  run_cmd "test -d '$assets_dst'" test -d "$assets_dst"
  run_cmd "rm -rf '$tmp_extract'" rm -rf "$tmp_extract"
  run_cmd "mkdir -p '$tmp_extract'" mkdir -p "$tmp_extract"
  run_cmd "tar -xzf '$SRC_ASSETS_TAR' -C '$tmp_extract'" tar -xzf "$SRC_ASSETS_TAR" -C "$tmp_extract"
  run_cmd "test -d '$tmp_extract/.data'" test -d "$tmp_extract/.data"

  run_cmd "mv '$assets_dst' '${assets_dst}.prev_${TS}'" mv "$assets_dst" "${assets_dst}.prev_${TS}"
  run_cmd "mv '$tmp_extract/.data' '$assets_dst'" mv "$tmp_extract/.data" "$assets_dst"
}

step_restore_db() {
  require_i_know "restore_db"
  ensure_evidence_dirs
  run_cmd "cd '$APP_ROOT'" cd "$APP_ROOT"

  if [[ -z "$SRC_DUMP_FILE" ]]; then
    SRC_DUMP_FILE="$EVIDENCE_DIR/src_artifacts/para.src.dump"
  fi
  if (( dry_run == 0 )) && [[ ! -f "$SRC_DUMP_FILE" ]]; then
    die "src_dump_missing=$SRC_DUMP_FILE"
  fi

  run_cmd "compose exec -T postgres sh -c 'cat > /tmp/para.src.dump' < '$SRC_DUMP_FILE'" \
    copy_dump_into_postgres

  run_cmd "compose exec -T postgres psql drop+recreate public schema > '$LOG_DIR/pg_reset_schema.txt'" \
    pg_reset_public_schema_to_log

  run_cmd "compose exec -T postgres pg_restore (--no-owner/--no-acl) > '$LOG_DIR/pg_restore.txt'" \
    pg_restore_to_log
}

step_migrate() {
  ensure_evidence_dirs
  run_cmd "cd '$APP_ROOT'" cd "$APP_ROOT"
  run_cmd "compose --profile migrate run --rm migrate > '$LOG_DIR/alembic-upgrade.txt'" \
    migrate_to_log
}

step_up() {
  ensure_evidence_dirs
  run_cmd "cd '$APP_ROOT'" cd "$APP_ROOT"
  run_cmd "compose up -d api worker" compose up -d api worker
  run_cmd "compose ps > '$OUT_DIR/compose-ps.after.txt'" compose_ps_to_file "$OUT_DIR/compose-ps.after.txt"
}

step_health() {
  ensure_evidence_dirs

  if [[ -z "$PROD_BASE_URL" ]]; then
    die "missing_required=--prod-base-url"
  fi
  local url="${PROD_BASE_URL%/}/api/v1/health"

  run_cmd "curl -fsS '$url' > '$OUT_DIR/health.json'" \
    curl_to_file "$url" "$OUT_DIR/health.json"

  run_cmd "python3 assert health status==ok" \
    python3 - <<PY
import json
from pathlib import Path

p = Path(${OUT_DIR@Q}) / "health.json"
obj = json.loads(p.read_text(encoding="utf-8"))
assert obj.get("status") == "ok", obj
print("health: ok")
PY
}

step_smoke_core() {
  ensure_evidence_dirs
  run_cmd "cd '$APP_ROOT'" cd "$APP_ROOT"

  if [[ -z "$PROD_BASE_URL" ]]; then
    die "missing_required=--prod-base-url"
  fi
  if [[ -z "$WS_BASE" ]]; then
    die "missing_required=--ws-base"
  fi

  if (( dry_run == 1 )); then
    printf 'NOTE: smoke-core is interactive; it will prompt for email/password (password is not echoed).\n'
    return 0
  fi

  compose exec api env API_BASE="$PROD_BASE_URL" WS_BASE="$WS_BASE" uv run python - <<'PY'
import asyncio
import getpass
import json
import os
import ssl
import urllib.error
import urllib.request

import websockets  # type: ignore


API_BASE = os.environ["API_BASE"].rstrip("/")
WS_BASE = os.environ["WS_BASE"].rstrip("/")


def http_json(method: str, url: str, *, headers: dict[str, str] | None = None, body: dict | None = None) -> dict:
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
        return json.loads(raw)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"http_error status={e.code} url={url}")


email = input("Smoke email: ").strip()
password = getpass.getpass("Smoke password (not echoed): ")

tokens = http_json("POST", f"{API_BASE}/api/v1/auth/login", body={"email": email, "password": password})
access = tokens.get("access_token")
if not isinstance(access, str) or not access:
    raise RuntimeError("missing access_token")

_ = http_json("GET", f"{API_BASE}/api/v1/auth/me", headers={"Authorization": f"Bearer {access}"})
print("login/me: ok")

save = http_json(
    "POST",
    f"{API_BASE}/api/v1/saves",
    headers={"Authorization": f"Bearer {access}"},
    body={"name": "task17-smoke"},
)
save_id = save.get("id")
if not isinstance(save_id, str) or not save_id:
    raise RuntimeError("missing save_id")


async def ws_chat_smoke() -> None:
    ws_url = f"{WS_BASE}/ws/v1?save_id={save_id}&resume_from=0"
    try:
        async with websockets.connect(ws_url, extra_headers={"Authorization": f"Bearer {access}"}) as ws:
            for _ in range(200):
                msg = json.loads(await ws.recv())
                if msg.get("type") == "HELLO":
                    break
            else:
                raise RuntimeError("no HELLO")

            await ws.send(
                json.dumps(
                    {
                        "type": "CHAT_SEND",
                        "payload": {"text": "task17 smoke"},
                        "client_request_id": "task17-smoke",
                    }
                )
            got_token = False
            for _ in range(5000):
                msg = json.loads(await ws.recv())
                t = msg.get("type")
                if t == "CHAT_TOKEN":
                    got_token = True
                    continue
                if t == "CHAT_DONE":
                    if not got_token:
                        raise RuntimeError("CHAT_DONE before CHAT_TOKEN")
                    payload = msg.get("payload") or {}
                    if payload.get("interrupted") is not False:
                        raise RuntimeError("unexpected interrupted")
                    print("ws chat: ok")
                    return
            raise RuntimeError("no CHAT_DONE")
    except Exception as e:
        raise RuntimeError(f"ws_failed type={type(e).__name__}")


asyncio.run(ws_chat_smoke())

_ = http_json(
    "POST",
    f"{API_BASE}/api/v1/knowledge/query",
    headers={"Authorization": f"Bearer {access}"},
    body={"query": "hello", "top_k": 3},
)
print("knowledge query: ok")

assets = http_json(
    "GET",
    f"{API_BASE}/api/v1/ugc/assets?limit=1",
    headers={"Authorization": f"Bearer {access}"},
)
items = assets.get("items")
if isinstance(items, list) and items and isinstance(items[0], dict) and isinstance(items[0].get("id"), str):
    asset_id = items[0]["id"]
    url = f"{API_BASE}/api/v1/ugc/assets/{asset_id}/download"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {access}")
    with urllib.request.urlopen(req, context=ssl.create_default_context(), timeout=20) as resp:
        _ = resp.read(64)
    print("ugc download: ok")
else:
    print("ugc download: skipped (no assets)")

print("smoke: ok")
PY
}

preflight

printf 'dry_run=%s\n' "$dry_run"
printf 'app_root=%s\n' "$APP_ROOT"
printf 'env_file=%s\n' "$ENV_FILE"
printf 'compose_file=%s\n' "$COMPOSE_FILE"
printf 'compose_project=%s\n' "$COMPOSE_PROJECT"
printf 'evidence_dir=%s\n' "$EVIDENCE_DIR"

if (( do_freeze == 1 )); then step_freeze; fi
if (( do_backup == 1 )); then step_backup; fi
if (( do_restore_assets == 1 )); then step_restore_assets; fi
if (( do_restore_db == 1 )); then step_restore_db; fi
if (( do_migrate == 1 )); then step_migrate; fi
if (( do_up == 1 )); then step_up; fi
if (( do_health == 1 )); then step_health; fi
if (( do_smoke_core == 1 )); then step_smoke_core; fi

printf 'ok=1\n'
