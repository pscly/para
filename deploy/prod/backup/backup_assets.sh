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
  bash deploy/prod/backup/backup_assets.sh [--dry-run] [--help]
                                      [--backup-root <dir>]
                                      [--assets-dir <dir>]
                                      [--method tar|rsync]

目标:
  生产资产快照（server `.data` 目录）：
    - tar：生成单个压缩包（默认）
    - rsync：镜像到备份目录（可选）

安全:
  - 不写入任何真实凭据。
  - 不读取/打印任何 secrets。

参数:
  -h, --help          输出帮助并退出
  --dry-run           只打印将执行的命令（不做写操作）
  --backup-root <dir> 备份根目录（默认: /root/dockers/para/backups）
  --assets-dir <dir>  资产目录（默认: /root/dockers/para/data/server/.data）
  --method <m>        tar|rsync（默认: tar）

环境变量（可覆盖同名默认值）:
  BACKUP_ROOT   备份根目录
  ASSETS_DIR    资产目录
  ASSETS_METHOD tar|rsync
  TIMESTAMP     备份时间戳（默认自动生成 YYYYmmddHHMMSS）

产物路径约定:
  资产备份:
    $BACKUP_ROOT/assets/<timestamp>/.data.tar.gz   (tar)
    $BACKUP_ROOT/assets/<timestamp>/.data/         (rsync)
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

dry_run=0

BACKUP_ROOT="${BACKUP_ROOT:-/root/dockers/para/backups}"
ASSETS_DIR="${ASSETS_DIR:-/root/dockers/para/data/server/.data}"
ASSETS_METHOD="${ASSETS_METHOD:-tar}"
TIMESTAMP="${TIMESTAMP:-}"

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
    --backup-root)
      BACKUP_ROOT="${2:-}"
      [[ -n "$BACKUP_ROOT" ]] || die_usage "missing_value_for=--backup-root"
      shift 2
      ;;
    --assets-dir)
      ASSETS_DIR="${2:-}"
      [[ -n "$ASSETS_DIR" ]] || die_usage "missing_value_for=--assets-dir"
      shift 2
      ;;
    --method)
      ASSETS_METHOD="${2:-}"
      [[ -n "$ASSETS_METHOD" ]] || die_usage "missing_value_for=--method"
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

need_cmd date
need_cmd mkdir
need_cmd tar

if [[ -z "$TIMESTAMP" ]]; then
  TIMESTAMP="$(date +%Y%m%d%H%M%S)"
fi

if [[ "$ASSETS_METHOD" != "tar" && "$ASSETS_METHOD" != "rsync" ]]; then
  die_usage "unknown_method=$ASSETS_METHOD"
fi

if [[ ! -d "$ASSETS_DIR" ]]; then
  die_usage "assets_dir_not_found=$ASSETS_DIR"
fi

step_marker "INFO" "计划参数"
printf 'repo_root=%s\n' "$repo_root"
printf 'BACKUP_ROOT=%s\n' "$BACKUP_ROOT"
printf 'ASSETS_DIR=%s\n' "$ASSETS_DIR"
printf 'ASSETS_METHOD=%s\n' "$ASSETS_METHOD"
printf 'TIMESTAMP=%s\n' "$TIMESTAMP"

backup_dir="$BACKUP_ROOT/assets/$TIMESTAMP"
archive_path="$backup_dir/.data.tar.gz"
rsync_dst="$backup_dir/.data"

step_marker "STEP" "创建备份目录"
run_cmd "mkdir -p '$backup_dir'" mkdir -p "$backup_dir"

step_marker "STEP" "生成资产快照"
if [[ "$ASSETS_METHOD" == "tar" ]]; then
  assets_parent="$(cd "$(dirname "$ASSETS_DIR")" && pwd)"
  assets_base="$(basename "$ASSETS_DIR")"
  run_cmd "tar -C '$assets_parent' -czf '$archive_path' '$assets_base'" \
    tar -C "$assets_parent" -czf "$archive_path" "$assets_base"
  if (( dry_run == 0 )); then
    chmod 600 "$archive_path" || true
  fi
  step_marker "OK" "资产快照完成"
  printf 'assets_archive=%s\n' "$archive_path"
else
  need_cmd rsync
  run_cmd "rsync -a --delete '$ASSETS_DIR/' '$rsync_dst/'" \
    rsync -a --delete "${ASSETS_DIR%/}/" "${rsync_dst%/}/"
  step_marker "OK" "资产快照完成"
  printf 'assets_dir=%s\n' "$rsync_dst"
fi
