#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

step_marker() {
  local kind="$1"
  local name="$2"
  printf '\n========== [%s] %s ==========%s' "$kind" "$name" $'\n'
}

usage() {
  cat <<'EOF'
用法:
  bash deploy/prod/migration/dry_run.sh [--dry-run] [--help]

目标:
  迁移演练（dry-run）：
    - 从源环境获取 DB dump（或使用已有 dump）并 restore 到目标 staging Postgres(pgvector)
    - 复制/同步 `.data` 文件资产到目标 staging
    - 跑一致性校验（rowcount 对比 + 明显孤儿行 + 资产抽样可读）
    - smoke：GET /api/v1/health 必须返回 status=ok

参数:
  -h, --help    输出帮助并退出（确定性文本，不包含 secrets）
  --dry-run     只打印“将要执行的命令清单”（会对 DSN 脱敏），不做任何写操作

环境变量（无 secrets 入库；脚本会避免打印 DSN 密码）:
  必需:
    DST_DATABASE_URL   目标 staging Postgres DSN
    DST_ASSETS_DIR     目标 staging `.data` 根目录（宿主机目录或容器内 /app/.data）

  推荐:
    SRC_DATABASE_URL   源 Postgres DSN（用于 pg_dump + rowcount 对比）
    SRC_ASSETS_DIR     源 `.data` 根目录（rsync 来源；可为远端 rsync 格式）

  dump 输入（二选一）:
    SRC_DB_DUMP_PATH   指向已有 dump 文件（推荐 pg_dump custom 格式）
    或提供 SRC_DATABASE_URL 由脚本生成 dump

  可调:
    WORK_DIR            工作目录（默认在 /tmp 下自动生成）
    SRC_DUMP_FORMAT     custom|directory|plain（默认 custom；custom/directory 用 pg_restore，plain 用 psql）
    DUMP_JOBS           pg_dump 并行 jobs（仅 directory 格式可用；默认 4）
    RESTORE_JOBS        pg_restore 并行 jobs（默认 1；>1 时不允许 single-transaction）
    RESTORE_SINGLE_TRANSACTION 1=pg_restore --single-transaction（默认 1；与 RESTORE_JOBS>1 互斥）
    DST_DROP_SCHEMA     1=restore 前 drop+recreate public schema（危险，仅 staging）
    ASSETS_SUBDIRS      需要同步的子目录（空格分隔；默认: knowledge ugc gallery）
    ASSETS_DELETE       1=rsync --delete（危险，仅 staging）
    VALIDATE_TABLES     逗号分隔表名列表（覆盖默认）
    ROWCOUNT_TIMEOUT_MS rowcount 超时（默认 3000）
    ASSETS_SAMPLE_N     资产抽样条数（默认 50）
    STAGING_API_BASE_URL 例如 http://127.0.0.1:18080（默认使用 STAGING_API_PORT 拼）
    STAGING_API_PORT    默认 18080

退出码:
  0  全部步骤通过
  1  执行失败/一致性校验失败
  2  参数/环境变量缺失
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
  command -v "$name" >/dev/null 2>&1 || die_usage "missing_required_command=$name"
}

redact_dsn() {
  local dsn="${1:-}"
  if [[ -z "$dsn" ]]; then
    printf ''
    return 0
  fi

  python3 - "$dsn" <<'PY'
import os
import re
import sys
from urllib.parse import urlsplit, urlunsplit

dsn = sys.argv[1]

def redact_url(u: str) -> str:
    try:
        parts = urlsplit(u)
    except Exception:
        return u
    if not parts.scheme or not parts.netloc:
        return u

    netloc = parts.netloc
    if "@" in netloc and ":" in netloc.split("@", 1)[0]:
        userinfo, hostinfo = netloc.split("@", 1)
        user, _pw = userinfo.split(":", 1)
        netloc = f"{user}:***@{hostinfo}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))

if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", dsn):
    print(redact_url(dsn))
else:
    dsn = re.sub(r"(password=)(\S+)", r"\1***", dsn)
    print(dsn)
PY
}

run_step() {
  local step_name="$1"
  local cmd_display="$2"
  shift 2

  step_marker "STEP START" "$step_name"
  printf '+ %s\n' "$cmd_display"

  if ! "$@"; then
    step_marker "STEP FAIL" "$step_name"
    printf 'failed_step=%s\n' "$step_name"
    printf 'failed_cmd=%s\n' "$cmd_display"
    return 1
  fi

  step_marker "STEP OK" "$step_name"
}

plan_steps() {
  STEP_NAMES=(
    "preflight"
    "db_dump"
    "db_restore"
    "assets_sync"
    "validate_db"
    "validate_assets"
    "smoke_health"
  )
  STEP_TITLES=(
    "前置检查（命令/环境）"
    "导出/准备源 DB dump"
    "restore 到目标 staging Postgres"
    "同步文件资产（.data）"
    "一致性校验（DB：rowcount + orphan）"
    "一致性校验（Assets：抽样可读）"
    "Smoke（/api/v1/health == ok）"
  )
}

print_dry_run() {
  plan_steps
  step_marker "DRY RUN" "将要执行的命令清单（不会执行）"

  local src_dsn_redacted
  local dst_dsn_redacted
  src_dsn_redacted="$(redact_dsn "${SRC_DATABASE_URL:-}")"
  dst_dsn_redacted="$(redact_dsn "${DST_DATABASE_URL:-}")"

  printf 'repo_root=%s\n' "$repo_root"
  printf 'work_dir=%s\n' "${WORK_DIR:-<auto>}"
  printf 'SRC_DATABASE_URL=%s\n' "${src_dsn_redacted:-<unset>}"
  printf 'DST_DATABASE_URL=%s\n' "${dst_dsn_redacted:-<unset>}"
  printf 'SRC_DB_DUMP_PATH=%s\n' "${SRC_DB_DUMP_PATH:-<unset>}"
  printf 'SRC_ASSETS_DIR=%s\n' "${SRC_ASSETS_DIR:-<unset>}"
  printf 'DST_ASSETS_DIR=%s\n' "${DST_ASSETS_DIR:-<unset>}"
  printf 'ASSETS_SUBDIRS=%s\n' "${ASSETS_SUBDIRS:-knowledge ugc gallery}"
  printf 'ASSETS_DELETE=%s\n' "${ASSETS_DELETE:-0}"
  printf 'DST_DROP_SCHEMA=%s\n' "${DST_DROP_SCHEMA:-0}"
  printf 'SRC_DUMP_FORMAT=%s\n' "${SRC_DUMP_FORMAT:-custom}"
  printf 'DUMP_JOBS=%s\n' "${DUMP_JOBS:-4}"
  printf 'RESTORE_JOBS=%s\n' "${RESTORE_JOBS:-1}"
  printf 'RESTORE_SINGLE_TRANSACTION=%s\n' "${RESTORE_SINGLE_TRANSACTION:-1}"
  printf 'ROWCOUNT_TIMEOUT_MS=%s\n' "${ROWCOUNT_TIMEOUT_MS:-3000}"
  printf 'ASSETS_SAMPLE_N=%s\n' "${ASSETS_SAMPLE_N:-50}"
  printf 'STAGING_API_BASE_URL=%s\n' "${STAGING_API_BASE_URL:-<auto>}"
  printf 'STAGING_API_PORT=%s\n' "${STAGING_API_PORT:-18080}"
  printf '\n'

  printf '1. pg_dump 或使用已有 dump\n'
  printf '   - 若设置 SRC_DB_DUMP_PATH：直接使用该文件\n'
  printf '   - 否则：按 SRC_DUMP_FORMAT 生成到 $WORK_DIR 下（custom=src.dump, directory=src.dumpdir, plain=src.sql）\n\n'
  printf '2. restore 到 DST_DATABASE_URL\n'
  printf '   - custom/directory: pg_restore --clean --if-exists --no-owner --no-acl [--single-transaction|--jobs N] --dbname "$DST_DATABASE_URL" <dump>\n'
  printf '   - plain:            psql "$DST_DATABASE_URL" -v ON_ERROR_STOP=1 -f <sql>\n\n'
  printf '3. rsync 资产\n'
  printf '   - rsync -a [--delete] "$SRC_ASSETS_DIR/<subdir>/" "$DST_ASSETS_DIR/<subdir>/"\n\n'
  printf '4. DB 校验\n'
  printf '   - python3 deploy/prod/migration/validate_db.py --src "$SRC_DATABASE_URL" --dst "$DST_DATABASE_URL"\n\n'
  printf '5. Assets 校验\n'
  printf '   - python3 deploy/prod/migration/validate_assets.py --db "$DST_DATABASE_URL" --assets-root "$DST_ASSETS_DIR"\n\n'
  printf '6. smoke\n'
  printf '   - curl -fsS "$STAGING_API_BASE_URL/api/v1/health" 并断言 status=ok\n'
}

preflight() {
  need_cmd python3
  need_cmd psql
  need_cmd pg_dump
  need_cmd pg_restore
  need_cmd rsync
  need_cmd curl

  if [[ -z "${DST_DATABASE_URL:-}" ]]; then
    die_usage "missing_env=DST_DATABASE_URL"
  fi
  if [[ -z "${DST_ASSETS_DIR:-}" ]]; then
    die_usage "missing_env=DST_ASSETS_DIR"
  fi
}

ensure_work_dir() {
  if [[ -n "${WORK_DIR:-}" ]]; then
    mkdir -p "$WORK_DIR"
    return 0
  fi
  WORK_DIR="$(mktemp -d -t para-migration-dryrun-XXXXXXXX)"
  export WORK_DIR
}

maybe_drop_schema() {
  if [[ "${DST_DROP_SCHEMA:-0}" != "1" ]]; then
    return 0
  fi
  step_marker "DANGER" "DST_DROP_SCHEMA=1：将 drop public schema（仅适用于 staging）"
  psql "${DST_DATABASE_URL}" -v ON_ERROR_STOP=1 -X -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
}

prepare_dump() {
  ensure_work_dir

  local dump_format="${SRC_DUMP_FORMAT:-custom}"
  local dump_path="${SRC_DB_DUMP_PATH:-}"
  local dump_jobs="${DUMP_JOBS:-4}"

  if [[ "${dump_format}" != "custom" && "${dump_format}" != "directory" && "${dump_format}" != "plain" ]]; then
    printf 'ERROR: unknown SRC_DUMP_FORMAT=%s (want: custom|directory|plain)\n' "$dump_format" >&2
    return 1
  fi

  if [[ -n "$dump_path" ]]; then
    if [[ "$dump_format" == "directory" ]]; then
      if [[ ! -d "$dump_path" ]]; then
        printf 'ERROR: dump_dir_not_found=%s\n' "$dump_path" >&2
        return 1
      fi
    else
      if [[ ! -f "$dump_path" ]]; then
        printf 'ERROR: dump_file_not_found=%s\n' "$dump_path" >&2
        return 1
      fi
    fi
    printf 'using_dump=%s\n' "$dump_path"
    printf 'dump_format=%s\n' "$dump_format"
    export _DRYRUN_DUMP_PATH="$dump_path"
    export _DRYRUN_DUMP_FORMAT="$dump_format"
    return 0
  fi

  if [[ -z "${SRC_DATABASE_URL:-}" ]]; then
    printf 'ERROR: missing SRC_DB_DUMP_PATH and SRC_DATABASE_URL (need one)\n' >&2
    return 1
  fi

  # 注意：pg_dump 不支持 restore 侧的“单事务”开关；一致性由 pg_dump 的一致性快照机制保障。
  if [[ "$dump_format" == "custom" ]]; then
    dump_path="$WORK_DIR/src.dump"
    pg_dump --format=custom --no-owner --no-acl --file "$dump_path" "${SRC_DATABASE_URL}"
  elif [[ "$dump_format" == "directory" ]]; then
    dump_path="$WORK_DIR/src.dumpdir"
    rm -rf "$dump_path"
    pg_dump --format=directory --no-owner --no-acl --file "$dump_path" --jobs "$dump_jobs" "${SRC_DATABASE_URL}"
  else
    dump_path="$WORK_DIR/src.sql"
    pg_dump --format=plain --no-owner --no-acl --file "$dump_path" "${SRC_DATABASE_URL}"
  fi

  printf 'dump_path=%s\n' "$dump_path"
  export _DRYRUN_DUMP_PATH="$dump_path"
  export _DRYRUN_DUMP_FORMAT="$dump_format"
}

restore_dump() {
  maybe_drop_schema

  local dump_path="${_DRYRUN_DUMP_PATH:-}"
  local dump_format="${_DRYRUN_DUMP_FORMAT:-custom}"
  local restore_jobs="${RESTORE_JOBS:-1}"
  local restore_single_tx="${RESTORE_SINGLE_TRANSACTION:-1}"
  if [[ -z "$dump_path" ]]; then
    printf 'ERROR: internal_missing_dump_path\n' >&2
    return 1
  fi

  if [[ "$restore_jobs" =~ ^[0-9]+$ ]]; then
    :
  else
    printf 'ERROR: invalid RESTORE_JOBS=%s (want integer)\n' "$restore_jobs" >&2
    return 1
  fi
  if (( restore_jobs > 1 )) && [[ "$restore_single_tx" == "1" ]]; then
    printf 'ERROR: RESTORE_SINGLE_TRANSACTION=1 conflicts with RESTORE_JOBS>1 (pg_restore does not support both)\n' >&2
    return 1
  fi

  psql "${DST_DATABASE_URL}" -v ON_ERROR_STOP=1 -X -c 'SELECT 1' >/dev/null

  if [[ "$dump_format" == "custom" || "$dump_format" == "directory" ]]; then
    local -a restore_args
    restore_args=(
      --clean
      --if-exists
      --no-owner
      --no-acl
      --exit-on-error
      --dbname "${DST_DATABASE_URL}"
    )
    if (( restore_jobs > 1 )); then
      restore_args+=(--jobs "$restore_jobs")
    elif [[ "$restore_single_tx" == "1" ]]; then
      restore_args+=(--single-transaction)
    fi
    pg_restore "${restore_args[@]}" "$dump_path"
  else
    psql "${DST_DATABASE_URL}" -v ON_ERROR_STOP=1 -X -f "$dump_path"
  fi
}

sync_assets() {
  if [[ -z "${SRC_ASSETS_DIR:-}" ]]; then
    step_marker "SKIP" "SRC_ASSETS_DIR 未设置：跳过资产同步（仍会跑 validate_assets，它将依赖 DST_ASSETS_DIR）"
    return 0
  fi

  local subdirs="${ASSETS_SUBDIRS:-knowledge ugc gallery}"
  local delete_flag=()
  if [[ "${ASSETS_DELETE:-0}" == "1" ]]; then
    delete_flag=(--delete)
  fi

  local d
  for d in $subdirs; do
    local disp_delete=""
    if [[ "${ASSETS_DELETE:-0}" == "1" ]]; then
      disp_delete="--delete "
    fi
    run_step "rsync $d" "rsync -a ${disp_delete}<src>/$d/ <dst>/$d/" \
      rsync -a "${delete_flag[@]}" "${SRC_ASSETS_DIR%/}/$d/" "${DST_ASSETS_DIR%/}/$d/"
  done
}

validate_db() {
  local args=()
  if [[ -n "${SRC_DATABASE_URL:-}" ]]; then
    args+=(--src "${SRC_DATABASE_URL}")
  fi
  args+=(--dst "${DST_DATABASE_URL}")
  if [[ -n "${VALIDATE_TABLES:-}" ]]; then
    args+=(--tables "${VALIDATE_TABLES}")
  fi
  args+=(--rowcount-timeout-ms "${ROWCOUNT_TIMEOUT_MS:-3000}")

  python3 "$repo_root/deploy/prod/migration/validate_db.py" "${args[@]}"
}

validate_assets() {
  python3 "$repo_root/deploy/prod/migration/validate_assets.py" \
    --db "${DST_DATABASE_URL}" \
    --assets-root "${DST_ASSETS_DIR}" \
    --sample-n "${ASSETS_SAMPLE_N:-50}"
}

smoke_health() {
  local port="${STAGING_API_PORT:-18080}"
  local base="${STAGING_API_BASE_URL:-http://127.0.0.1:${port}}"
  local url="${base%/}/api/v1/health"

  step_marker "SMOKE" "health url=${url}"
  local body
  body="$(curl -fsS "$url")"
  python3 - <<PY
import json
import sys

url = ${url@Q}
body = ${body@Q}
obj = json.loads(body)
status = obj.get('status')
print(json.dumps(obj, ensure_ascii=True, sort_keys=True))
if status != 'ok':
    print(f"ERROR: health_status_not_ok status={status}")
    sys.exit(1)
print('smoke_ok=1')
PY
}

run_all() {
  trap 'step_marker "CLEANUP" "work_dir=${WORK_DIR:-<none>}"' EXIT INT TERM

  run_step "Preflight" "检查命令与必需 env" preflight || return 1
  run_step "Prepare dump" "pg_dump 或使用 SRC_DB_DUMP_PATH" prepare_dump || return 1
  run_step "Restore" "restore dump -> DST_DATABASE_URL" restore_dump || return 1
  run_step "Assets" "rsync SRC_ASSETS_DIR -> DST_ASSETS_DIR" sync_assets || return 1
  run_step "Validate DB" "validate_db.py" validate_db || return 1
  run_step "Validate assets" "validate_assets.py" validate_assets || return 1
  run_step "Smoke" "GET /api/v1/health" smoke_health || return 1

  step_marker "TASK" "ALL GREEN"
}

dry_run=0
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

if (( dry_run == 1 )); then
  print_dry_run
  exit 0
fi

run_all
