#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

step_marker() {
  local kind="$1"
  local name="$2"
  printf '\n========== [%s] %s ==========%s' "$kind" "$name" $'\n'
}

usage() {
  cat <<'EOF'
用法:
  bash deploy/prod/backup/restore_to_staging.sh [--dry-run] [--help]
                                          [--timestamp <ts>]
                                          [--pg-dump <path>] [--pg-format custom|directory]
                                          [--assets-archive <path>]
                                          [--backup-root <dir>]
                                          [--staging-root <dir>]
                                          [--project-name <name>]
                                          [--api-port <port>]
                                          [--server-image <image>]

目标:
  从“生产备份产物”恢复到一套隔离的 staging（docker compose project + 独立数据目录），并进行最小 smoke：
    - restore Postgres（pg_restore）
    - 解压 assets 到 staging `.data`
    - 跑 alembic upgrade head
    - 启动 api/worker
    - curl /api/v1/health 断言 status==ok

安全:
  - 不写入任何真实凭据；不读取/打印生产 DSN/口令。
  - staging 默认 ENV=staging，避免触发生产 fail-fast guard。

参数:
  -h, --help              输出帮助并退出
  --dry-run               只打印将执行的命令（不做写操作）
  --timestamp <ts>        备份时间戳（用于自动定位备份文件；推荐）
  --pg-dump <path>        指定 pg dump 路径（custom=文件；directory=目录）
  --pg-format <fmt>       custom|directory（默认自动推断）
  --assets-archive <path> 指定 assets 归档（通常为 .data.tar.gz）
  --backup-root <dir>     备份根目录（默认: /root/dockers/para/backups）
  --staging-root <dir>    staging 根目录（默认: $BACKUP_ROOT/staging/<ts|now>）
  --project-name <name>   docker compose project name（默认: para-staging-<ts|now>）
  --api-port <port>       staging API 绑定到 127.0.0.1:<port>（默认: 28080）
  --server-image <image>  server 镜像（默认: para-server:prod）

环境变量（可覆盖同名默认值）:
  BACKUP_ROOT
  TIMESTAMP
  PG_DUMP_PATH
  PG_DUMP_FORMAT
  ASSETS_ARCHIVE
  STAGING_ROOT
  STAGING_PROJECT_NAME
  STAGING_API_PORT
  SERVER_IMAGE
  STAGING_POSTGRES_DB
  STAGING_POSTGRES_USER
  STAGING_POSTGRES_PASSWORD

备份路径约定（与备份脚本一致）:
  DB:
    $BACKUP_ROOT/pg/<timestamp>/para.dump
    $BACKUP_ROOT/pg/<timestamp>/para.dir/
  Assets:
    $BACKUP_ROOT/assets/<timestamp>/.data.tar.gz
EOF
}

die_usage() {
  local msg="$1"
  printf 'ERROR: %s\n\n' "$msg" >&2
  usage >&2
  exit 2
}

need_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die_usage "missing_required_command=${name}"
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

extract_assets() {
  rm -rf "$STAGING_ASSETS_DIR"
  mkdir -p "$STAGING_SERVER_DIR"
  tar -xzf "$ASSETS_ARCHIVE" -C "$STAGING_SERVER_DIR"
}

copy_dump_custom_into_pg() {
  cat "$PG_DUMP_PATH" | compose exec -T postgres sh -c 'cat > /tmp/para.dump'
}

copy_dump_dir_into_pg() {
  local dump_parent
  local dump_base
  dump_parent="$(cd "$(dirname "$PG_DUMP_PATH")" && pwd)"
  dump_base="$(basename "$PG_DUMP_PATH")"
  tar -C "$dump_parent" -cf - "$dump_base" | compose exec -T postgres sh -c 'rm -rf /tmp/para.dir && mkdir -p /tmp && tar -xf - -C /tmp'
}

smoke_health() {
  local tries=60
  local i
  local body
  for i in $(seq 1 "$tries"); do
    if body="$(curl -fsS "$health_url" 2>/dev/null)"; then
      if python3 - "$body" <<'PY'
import json
import sys

body = sys.argv[1]
obj = json.loads(body)
status = obj.get("status")
if status != "ok":
    raise SystemExit(1)
PY
      then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

compose() {
  docker compose -f "$STAGING_COMPOSE_FILE" -p "$STAGING_PROJECT" "$@"
}

wait_postgres() {
  local tries=60
  local i
  for i in $(seq 1 "$tries"); do
    if compose exec -T postgres pg_isready -U "${STAGING_POSTGRES_USER}" -d "${STAGING_POSTGRES_DB}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

dry_run=0

BACKUP_ROOT="${BACKUP_ROOT:-/root/dockers/para/backups}"
TIMESTAMP="${TIMESTAMP:-}"

PG_DUMP_PATH="${PG_DUMP_PATH:-}"
PG_DUMP_FORMAT="${PG_DUMP_FORMAT:-}"
ASSETS_ARCHIVE="${ASSETS_ARCHIVE:-}"

STAGING_ROOT="${STAGING_ROOT:-}"
STAGING_PROJECT="${STAGING_PROJECT_NAME:-}"
STAGING_API_PORT="${STAGING_API_PORT:-28080}"
SERVER_IMAGE="${SERVER_IMAGE:-para-server:prod}"

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
    --timestamp)
      TIMESTAMP="${2:-}"
      [[ -n "$TIMESTAMP" ]] || die_usage "missing_value_for=--timestamp"
      shift 2
      ;;
    --pg-dump)
      PG_DUMP_PATH="${2:-}"
      [[ -n "$PG_DUMP_PATH" ]] || die_usage "missing_value_for=--pg-dump"
      shift 2
      ;;
    --pg-format)
      PG_DUMP_FORMAT="${2:-}"
      [[ -n "$PG_DUMP_FORMAT" ]] || die_usage "missing_value_for=--pg-format"
      shift 2
      ;;
    --assets-archive)
      ASSETS_ARCHIVE="${2:-}"
      [[ -n "$ASSETS_ARCHIVE" ]] || die_usage "missing_value_for=--assets-archive"
      shift 2
      ;;
    --backup-root)
      BACKUP_ROOT="${2:-}"
      [[ -n "$BACKUP_ROOT" ]] || die_usage "missing_value_for=--backup-root"
      shift 2
      ;;
    --staging-root)
      STAGING_ROOT="${2:-}"
      [[ -n "$STAGING_ROOT" ]] || die_usage "missing_value_for=--staging-root"
      shift 2
      ;;
    --project-name)
      STAGING_PROJECT="${2:-}"
      [[ -n "$STAGING_PROJECT" ]] || die_usage "missing_value_for=--project-name"
      shift 2
      ;;
    --api-port)
      STAGING_API_PORT="${2:-}"
      [[ -n "$STAGING_API_PORT" ]] || die_usage "missing_value_for=--api-port"
      shift 2
      ;;
    --server-image)
      SERVER_IMAGE="${2:-}"
      [[ -n "$SERVER_IMAGE" ]] || die_usage "missing_value_for=--server-image"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      die_usage "unknown_arg=$1"
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  die_usage "unexpected_extra_args=$*"
fi

need_cmd docker
docker compose version >/dev/null 2>&1 || die_usage "docker_compose_not_available=1"
need_cmd tar
need_cmd curl
need_cmd python3
need_cmd date
need_cmd mkdir
need_cmd rm
need_cmd dirname
need_cmd basename
need_cmd sleep
need_cmd seq

STAGING_POSTGRES_DB="${STAGING_POSTGRES_DB:-para}"
STAGING_POSTGRES_USER="${STAGING_POSTGRES_USER:-para}"
STAGING_POSTGRES_PASSWORD="${STAGING_POSTGRES_PASSWORD:-para}"

if [[ -z "$TIMESTAMP" ]]; then
  TIMESTAMP="$(date +%Y%m%d%H%M%S)"
fi

if [[ -z "$STAGING_ROOT" ]]; then
  STAGING_ROOT="$BACKUP_ROOT/staging/$TIMESTAMP"
fi
if [[ -z "$STAGING_PROJECT" ]]; then
  STAGING_PROJECT="para-staging-$TIMESTAMP"
fi

if [[ -z "$PG_DUMP_PATH" ]]; then
  if [[ -f "$BACKUP_ROOT/pg/$TIMESTAMP/para.dump" ]]; then
    PG_DUMP_PATH="$BACKUP_ROOT/pg/$TIMESTAMP/para.dump"
  elif [[ -d "$BACKUP_ROOT/pg/$TIMESTAMP/para.dir" ]]; then
    PG_DUMP_PATH="$BACKUP_ROOT/pg/$TIMESTAMP/para.dir"
  elif (( dry_run == 1 )); then
    PG_DUMP_PATH="$BACKUP_ROOT/pg/$TIMESTAMP/para.dump"
  fi
fi

if [[ -z "$ASSETS_ARCHIVE" ]]; then
  if [[ -f "$BACKUP_ROOT/assets/$TIMESTAMP/.data.tar.gz" ]]; then
    ASSETS_ARCHIVE="$BACKUP_ROOT/assets/$TIMESTAMP/.data.tar.gz"
  elif (( dry_run == 1 )); then
    ASSETS_ARCHIVE="$BACKUP_ROOT/assets/$TIMESTAMP/.data.tar.gz"
  fi
fi

if [[ -z "$PG_DUMP_FORMAT" ]]; then
  if [[ -d "$PG_DUMP_PATH" ]]; then
    PG_DUMP_FORMAT="directory"
  else
    PG_DUMP_FORMAT="custom"
  fi
fi

if (( dry_run == 1 )); then
  step_marker "DRY RUN" "将要执行的命令清单（不会执行）"
  printf 'BACKUP_ROOT=%s\n' "$BACKUP_ROOT"
  printf 'TIMESTAMP=%s\n' "$TIMESTAMP"
  printf 'PG_DUMP_PATH=%s\n' "${PG_DUMP_PATH:-<unset>}"
  printf 'PG_DUMP_FORMAT=%s\n' "${PG_DUMP_FORMAT:-<unset>}"
  printf 'ASSETS_ARCHIVE=%s\n' "${ASSETS_ARCHIVE:-<unset>}"
  printf 'STAGING_ROOT=%s\n' "$STAGING_ROOT"
  printf 'STAGING_PROJECT_NAME=%s\n' "$STAGING_PROJECT"
  printf 'STAGING_API_PORT=%s\n' "$STAGING_API_PORT"
  printf 'SERVER_IMAGE=%s\n' "$SERVER_IMAGE"
  printf '\n'
  printf '1) 创建 staging 目录并生成 compose 文件（隔离 project + 独立数据目录）\n'
  printf '2) 启动 postgres/redis 并等待 healthy\n'
  printf '3) 解压 assets: tar -xzf "$ASSETS_ARCHIVE" -C "$STAGING_ROOT/server"\n'
  printf '4) 拷贝 dump 到容器 /tmp 并 pg_restore（custom|directory）\n'
  printf '5) alembic upgrade head\n'
  printf '6) 启动 api/worker 并 smoke: GET http://127.0.0.1:%s/api/v1/health -> status==ok\n' "$STAGING_API_PORT"
  exit 0
fi

if [[ -z "$PG_DUMP_PATH" ]]; then
  die_usage "missing_input=--timestamp_or_--pg-dump"
fi
if [[ -z "$ASSETS_ARCHIVE" ]]; then
  die_usage "missing_input=assets_archive_not_found_for_timestamp (pass --assets-archive)"
fi

if [[ "$PG_DUMP_FORMAT" != "custom" && "$PG_DUMP_FORMAT" != "directory" ]]; then
  die_usage "unknown_pg_format=$PG_DUMP_FORMAT"
fi

if [[ "$PG_DUMP_FORMAT" == "custom" && ! -f "$PG_DUMP_PATH" ]]; then
  die_usage "pg_dump_file_not_found=$PG_DUMP_PATH"
fi
if [[ "$PG_DUMP_FORMAT" == "directory" && ! -d "$PG_DUMP_PATH" ]]; then
  die_usage "pg_dump_dir_not_found=$PG_DUMP_PATH"
fi
if [[ ! -f "$ASSETS_ARCHIVE" ]]; then
  die_usage "assets_archive_not_found=$ASSETS_ARCHIVE"
fi

STAGING_POSTGRES_DATA_DIR="$STAGING_ROOT/postgres"
STAGING_REDIS_DATA_DIR="$STAGING_ROOT/redis"
STAGING_SERVER_DIR="$STAGING_ROOT/server"
STAGING_ASSETS_DIR="$STAGING_SERVER_DIR/.data"
STAGING_COMPOSE_FILE="$STAGING_ROOT/docker-compose.staging.yml"

step_marker "INFO" "计划参数（不会输出口令）"
printf 'repo_root=%s\n' "$repo_root"
printf 'BACKUP_ROOT=%s\n' "$BACKUP_ROOT"
printf 'TIMESTAMP=%s\n' "$TIMESTAMP"
printf 'PG_DUMP_PATH=%s\n' "$PG_DUMP_PATH"
printf 'PG_DUMP_FORMAT=%s\n' "$PG_DUMP_FORMAT"
printf 'ASSETS_ARCHIVE=%s\n' "$ASSETS_ARCHIVE"
printf 'STAGING_ROOT=%s\n' "$STAGING_ROOT"
printf 'STAGING_PROJECT_NAME=%s\n' "$STAGING_PROJECT"
printf 'STAGING_API_PORT=%s\n' "$STAGING_API_PORT"
printf 'SERVER_IMAGE=%s\n' "$SERVER_IMAGE"

step_marker "STEP" "创建 staging 目录"
run_cmd "mkdir -p '$STAGING_POSTGRES_DATA_DIR' '$STAGING_REDIS_DATA_DIR' '$STAGING_SERVER_DIR'" \
  mkdir -p "$STAGING_POSTGRES_DATA_DIR" "$STAGING_REDIS_DATA_DIR" "$STAGING_SERVER_DIR"

step_marker "STEP" "生成 staging compose（隔离 project + 独立数据目录）"
compose_yaml_content="$(
  cat <<YAML
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: ${STAGING_POSTGRES_DB}
      POSTGRES_USER: ${STAGING_POSTGRES_USER}
      POSTGRES_PASSWORD: ${STAGING_POSTGRES_PASSWORD}
    volumes:
      - ${STAGING_POSTGRES_DATA_DIR}:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${STAGING_POSTGRES_USER} -d ${STAGING_POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 30
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - ${STAGING_REDIS_DATA_DIR}:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  migrate:
    image: ${SERVER_IMAGE}
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      ENV: staging
      LOG_LEVEL: INFO
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: ${STAGING_POSTGRES_DB}
      POSTGRES_USER: ${STAGING_POSTGRES_USER}
      POSTGRES_PASSWORD: ${STAGING_POSTGRES_PASSWORD}
      CELERY_BROKER_URL: redis://redis:6379/0
      CELERY_RESULT_BACKEND: redis://redis:6379/0
      WS_REDIS_URL: redis://redis:6379/0
    volumes:
      - ${STAGING_ASSETS_DIR}:/app/.data
    command: ["sh", "-c", "alembic upgrade head"]
    restart: "no"

  api:
    image: ${SERVER_IMAGE}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      ENV: staging
      LOG_LEVEL: INFO
      HEALTH_TIMEOUT_S: "0.5"
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: ${STAGING_POSTGRES_DB}
      POSTGRES_USER: ${STAGING_POSTGRES_USER}
      POSTGRES_PASSWORD: ${STAGING_POSTGRES_PASSWORD}
      CELERY_BROKER_URL: redis://redis:6379/0
      CELERY_RESULT_BACKEND: redis://redis:6379/0
      WS_REDIS_URL: redis://redis:6379/0
    volumes:
      - ${STAGING_ASSETS_DIR}:/app/.data
    command: ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2"]
    ports:
      - "127.0.0.1:${STAGING_API_PORT}:8000"
    restart: unless-stopped

  worker:
    image: ${SERVER_IMAGE}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      api:
        condition: service_started
    environment:
      ENV: staging
      LOG_LEVEL: INFO
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: ${STAGING_POSTGRES_DB}
      POSTGRES_USER: ${STAGING_POSTGRES_USER}
      POSTGRES_PASSWORD: ${STAGING_POSTGRES_PASSWORD}
      CELERY_BROKER_URL: redis://redis:6379/0
      CELERY_RESULT_BACKEND: redis://redis:6379/0
      WS_REDIS_URL: redis://redis:6379/0
      CELERY_TASK_ALWAYS_EAGER: "0"
    volumes:
      - ${STAGING_ASSETS_DIR}:/app/.data
    command: ["sh", "-c", "celery -A app.workers.celery_app:celery_app worker -l INFO -c 1"]
    restart: unless-stopped
YAML
)"

if (( dry_run == 1 )); then
  printf '+ write_file %s (content omitted in dry-run)\n' "$STAGING_COMPOSE_FILE"
else
  umask 077
  mkdir -p "$(dirname "$STAGING_COMPOSE_FILE")"
  printf '%s\n' "$compose_yaml_content" >"$STAGING_COMPOSE_FILE"
fi

step_marker "STEP" "启动 staging deps（postgres/redis）"
run_cmd "docker compose -f '$STAGING_COMPOSE_FILE' -p '$STAGING_PROJECT' up -d postgres redis" \
  compose up -d postgres redis

step_marker "STEP" "等待 Postgres 就绪"
run_cmd "wait postgres (pg_isready)" wait_postgres || {
  step_marker "FAIL" "Postgres 未就绪"
  exit 1
}

step_marker "STEP" "恢复 assets 到 staging"
run_cmd "rm -rf '$STAGING_ASSETS_DIR' && mkdir -p '$STAGING_SERVER_DIR' && tar -xzf '$ASSETS_ARCHIVE' -C '$STAGING_SERVER_DIR'" \
  extract_assets

if [[ ! -d "$STAGING_ASSETS_DIR" ]]; then
  step_marker "FAIL" "assets 解压后未找到 .data 目录"
  printf 'expected_dir=%s\n' "$STAGING_ASSETS_DIR" >&2
  exit 1
fi

step_marker "STEP" "恢复 Postgres（pg_restore）"
if [[ "$PG_DUMP_FORMAT" == "custom" ]]; then
  run_cmd "cat '$PG_DUMP_PATH' | docker compose exec -T postgres sh -c 'cat > /tmp/para.dump'" \
    copy_dump_custom_into_pg
  run_cmd "docker compose exec -T postgres pg_restore --clean ... /tmp/para.dump" \
    compose exec -T postgres sh -c 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error -U "${POSTGRES_USER:-para}" -d "${POSTGRES_DB:-para}" /tmp/para.dump'
else
  run_cmd "tar -cf - '$PG_DUMP_PATH' | docker compose exec -T postgres tar -xf -" \
    copy_dump_dir_into_pg
  run_cmd "docker compose exec -T postgres pg_restore --clean ... /tmp/para.dir" \
    compose exec -T postgres sh -c 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error -U "${POSTGRES_USER:-para}" -d "${POSTGRES_DB:-para}" /tmp/para.dir'
fi

step_marker "STEP" "运行 alembic upgrade head（staging）"
run_cmd "docker compose run --rm migrate" compose run --rm migrate

step_marker "STEP" "启动 api/worker（staging）"
run_cmd "docker compose up -d api worker" compose up -d api worker

step_marker "STEP" "Smoke: GET /api/v1/health 断言 status==ok"
health_url="http://127.0.0.1:${STAGING_API_PORT}/api/v1/health"
printf 'health_url=%s\n' "$health_url"
run_cmd "curl -fsS '$health_url' | python3 assert status==ok" \
  smoke_health

step_marker "OK" "恢复演练完成"
printf 'staging_compose=%s\n' "$STAGING_COMPOSE_FILE"
printf 'staging_project=%s\n' "$STAGING_PROJECT"
printf 'staging_root=%s\n' "$STAGING_ROOT"
printf 'health_url=%s\n' "$health_url"
