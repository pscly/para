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
  bash deploy/prod/backup/backup_pg_dump.sh [--dry-run] [--help] [--format custom|directory]
                                     [--backup-root <dir>]
                                     [--compose-file <path>] [--env-file <path>] [--project-name <name>]

目标:
  在 pscly.cc 生产环境生成 Postgres 备份（推荐 custom 或 directory 格式）。
  默认在 Postgres 容器内执行 pg_dump（生产环境不 publish 5432）。

安全:
  - 不写入任何真实凭据；通过 env 或 --env-file 注入。
  - 输出不打印 POSTGRES_PASSWORD 或包含 password 的 DSN。

参数:
  -h, --help          输出帮助并退出（确定性文本，不包含 secrets）
  --dry-run           只打印将执行的命令（不做写操作）
  --format <fmt>      custom|directory（默认: custom）
  --backup-root <dir> 备份根目录（默认: /root/dockers/para/backups）
  --compose-file <p>  docker compose 文件（默认: deploy/prod/docker-compose.yml）
  --env-file <p>      显式传给 docker compose 的 env 文件（默认: /root/dockers/para/.env 若存在；否则不传）
  --project-name <n>  docker compose project name（默认: para）

环境变量（可覆盖同名默认值）:
  BACKUP_ROOT          备份根目录
  COMPOSE_FILE         compose 文件路径
  ENV_FILE             compose env 文件路径
  COMPOSE_PROJECT_NAME compose project name
  DUMP_FORMAT           custom|directory
  DUMP_JOBS             directory 格式并行 jobs（默认 4；custom 不使用）
  TIMESTAMP             备份时间戳（默认自动生成 YYYYmmddHHMMSS）

产物路径约定:
  DB 备份:
    $BACKUP_ROOT/pg/<timestamp>/para.dump      (custom)
    $BACKUP_ROOT/pg/<timestamp>/para.dir/      (directory)
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

compose() {
  local -a cmd
  cmd=(docker compose)

  if [[ -n "${ENV_FILE:-}" ]]; then
    cmd+=(--env-file "$ENV_FILE")
  fi

  cmd+=(-f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT")
  "${cmd[@]}" "$@"
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

dump_custom() {
  umask 077
  # 注意：pg_dump 不支持 restore 侧的“单事务”开关；一致性由 pg_dump 的一致性快照机制保障。
  compose exec -T postgres sh -c 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; pg_dump --format=custom --no-owner --no-acl -U "${POSTGRES_USER:-para}" -d "${POSTGRES_DB:-para}"' >"$dump_file"
  chmod 600 "$dump_file" || true
}

dump_directory() {
  umask 077
  rm -rf "$dump_dir"
  compose exec -T -e DUMP_JOBS="$DUMP_JOBS" postgres sh -c 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; rm -rf /tmp/para.dir && pg_dump --format=directory --no-owner --no-acl --file /tmp/para.dir --jobs "${DUMP_JOBS:-4}" -U "${POSTGRES_USER:-para}" -d "${POSTGRES_DB:-para}" && tar -C /tmp -cf - para.dir' |
    tar --no-same-owner -xf - -C "$backup_dir"
}

dry_run=0

BACKUP_ROOT="${BACKUP_ROOT:-/root/dockers/para/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-$repo_root/deploy/prod/docker-compose.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-para}"
DUMP_FORMAT="${DUMP_FORMAT:-custom}"
DUMP_JOBS="${DUMP_JOBS:-4}"
TIMESTAMP="${TIMESTAMP:-}"

if [[ -z "${ENV_FILE:-}" ]]; then
  if [[ -f /root/dockers/para/.env ]]; then
    ENV_FILE=/root/dockers/para/.env
  else
    ENV_FILE=""
  fi
fi

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
    --format)
      DUMP_FORMAT="${2:-}"
      [[ -n "$DUMP_FORMAT" ]] || die_usage "missing_value_for=--format"
      shift 2
      ;;
    --backup-root)
      BACKUP_ROOT="${2:-}"
      [[ -n "$BACKUP_ROOT" ]] || die_usage "missing_value_for=--backup-root"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:-}"
      [[ -n "$COMPOSE_FILE" ]] || die_usage "missing_value_for=--compose-file"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      [[ -n "$ENV_FILE" ]] || die_usage "missing_value_for=--env-file"
      shift 2
      ;;
    --project-name)
      COMPOSE_PROJECT="${2:-}"
      [[ -n "$COMPOSE_PROJECT" ]] || die_usage "missing_value_for=--project-name"
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
need_cmd date
need_cmd mkdir
need_cmd tar

if [[ ! -f "$COMPOSE_FILE" ]]; then
  die_usage "compose_file_not_found=$COMPOSE_FILE"
fi
if [[ -n "${ENV_FILE:-}" && ! -f "$ENV_FILE" ]]; then
  die_usage "env_file_not_found=$ENV_FILE"
fi

if [[ -z "$TIMESTAMP" ]]; then
  TIMESTAMP="$(date +%Y%m%d%H%M%S)"
fi

if [[ "$DUMP_FORMAT" != "custom" && "$DUMP_FORMAT" != "directory" ]]; then
  die_usage "unknown_format=$DUMP_FORMAT"
fi

step_marker "INFO" "计划参数（不会输出口令）"
printf 'repo_root=%s\n' "$repo_root"
printf 'COMPOSE_FILE=%s\n' "$COMPOSE_FILE"
printf 'ENV_FILE=%s\n' "${ENV_FILE:-<unset>}"
printf 'COMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT"
printf 'BACKUP_ROOT=%s\n' "$BACKUP_ROOT"
printf 'DUMP_FORMAT=%s\n' "$DUMP_FORMAT"
printf 'TIMESTAMP=%s\n' "$TIMESTAMP"
if [[ "$DUMP_FORMAT" == "directory" ]]; then
  printf 'DUMP_JOBS=%s\n' "$DUMP_JOBS"
fi

backup_dir="$BACKUP_ROOT/pg/$TIMESTAMP"
dump_file="$backup_dir/para.dump"
dump_dir="$backup_dir/para.dir"

step_marker "STEP" "创建备份目录"
run_cmd "mkdir -p '$backup_dir'" mkdir -p "$backup_dir"

step_marker "STEP" "执行 pg_dump（容器内）"
if [[ "$DUMP_FORMAT" == "custom" ]]; then
  run_cmd "docker compose exec -T postgres pg_dump (custom) > '$dump_file'" dump_custom
else
  run_cmd "docker compose exec -T postgres pg_dump (directory) | tar -xf - -C '$backup_dir'" dump_directory
fi

step_marker "OK" "备份完成"
if [[ "$DUMP_FORMAT" == "custom" ]]; then
  printf 'dump_path=%s\n' "$dump_file"
else
  printf 'dump_path=%s\n' "$dump_dir"
fi
