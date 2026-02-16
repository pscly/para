#!/usr/bin/env bash
# 生产远程部署脚本（在 pscly.cc 上执行）：显式 --env-file，且只替换 /root/dockers/para/app 代码目录。

set -Eeuo pipefail

log() {
  echo "[deploy] $*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

SHA="${1:-}"
if [[ -z "$SHA" ]]; then
  die "usage: remote_deploy.sh <git_sha>"
fi

ROOT_DIR="/root/dockers/para"
ENV_FILE="/root/dockers/para/.env"
RELEASES_DIR="${ROOT_DIR}/releases"

APP_DIR="${ROOT_DIR}/app"
APP_NEW_DIR="${ROOT_DIR}/app_new"
APP_PREV_DIR="${ROOT_DIR}/app_prev"
APP_PREV_OLD_DIR="${ROOT_DIR}/app_prev_old"

RELEASE_TGZ="${RELEASES_DIR}/${SHA}.tgz"
APP_FAILED_DIR="${ROOT_DIR}/app_failed_${SHA}_$(date +%Y%m%d%H%M%S)"

COMPOSE_PROJECT="para"
COMPOSE_FILE_REL="deploy/prod/docker-compose.yml"
HEALTH_URL="https://para.pscly.cc/api/v1/health"

compose() {
  docker compose --env-file "$ENV_FILE" -f "${APP_DIR}/${COMPOSE_FILE_REL}" -p "$COMPOSE_PROJECT" "$@"
}

rollback() {
  log "尝试最小回滚：恢复上一版代码目录并重启 compose（不删除数据卷）"

  local rollback_src=""
  if [[ -d "$APP_PREV_DIR" ]]; then
    rollback_src="$APP_PREV_DIR"
  elif [[ -d "$APP_PREV_OLD_DIR" ]]; then
    rollback_src="$APP_PREV_OLD_DIR"
  fi

  if [[ -n "$rollback_src" ]]; then
    if [[ -d "$APP_DIR" ]]; then
      mv "$APP_DIR" "$APP_FAILED_DIR" || true
    fi
    mv "$rollback_src" "$APP_DIR" || true

    if [[ -f "${APP_DIR}/${COMPOSE_FILE_REL}" ]]; then
      compose up -d --remove-orphans || true
    else
      log "回滚后 compose 文件不存在：${APP_DIR}/${COMPOSE_FILE_REL}"
    fi
  else
    log "未找到 ${APP_PREV_DIR} 或 ${APP_PREV_OLD_DIR}，无法回滚代码目录"
  fi
}

on_err() {
  local code="$1"
  local line="$2"
  log "部署失败（exit=${code} line=${line}），开始回滚"
  rollback
  exit "$code"
}

trap 'on_err $? $LINENO' ERR

on_signal() {
  local sig="$1"
  log "收到信号 ${sig}，开始回滚"
  rollback || true
  exit 130
}

trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

log "开始部署 sha=${SHA}"

command -v docker >/dev/null 2>&1 || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose not available"
command -v tar >/dev/null 2>&1 || die "tar not found"
command -v curl >/dev/null 2>&1 || die "curl not found"
command -v python3 >/dev/null 2>&1 || die "python3 not found"

[[ -f "$ENV_FILE" ]] || die "env file missing: $ENV_FILE"
[[ -f "$RELEASE_TGZ" ]] || die "release tarball missing: $RELEASE_TGZ"

mkdir -p "$RELEASES_DIR"

log "解压 release 到 ${APP_NEW_DIR}"
rm -rf "$APP_NEW_DIR"
mkdir -p "$APP_NEW_DIR"
tar -xzf "$RELEASE_TGZ" -C "$APP_NEW_DIR"

[[ -f "${APP_NEW_DIR}/${COMPOSE_FILE_REL}" ]] || die "compose file missing in release: ${APP_NEW_DIR}/${COMPOSE_FILE_REL}"

log "准备原子切换目录：${APP_DIR} -> ${APP_PREV_DIR}，${APP_NEW_DIR} -> ${APP_DIR}"
if [[ -d "$APP_DIR" ]]; then
  if [[ -d "$APP_PREV_DIR" ]]; then
    rm -rf "$APP_PREV_OLD_DIR"
    mv "$APP_PREV_DIR" "$APP_PREV_OLD_DIR"
  fi
  mv "$APP_DIR" "$APP_PREV_DIR"
fi
mv "$APP_NEW_DIR" "$APP_DIR"

log "构建镜像（用于迁移与服务启动）"
compose build

log "运行迁移（profile=migrate）"
compose --profile migrate run --rm migrate

log "启动/更新服务（up -d --remove-orphans）"
compose up -d --remove-orphans

log "Smoke: ${HEALTH_URL} 断言 status==ok"
for i in {1..30}; do
  if curl -fsS "$HEALTH_URL" | python3 -c 'import json,sys; j=json.load(sys.stdin); s=j.get("status"); assert s=="ok", f"status={s}"' >/dev/null 2>&1; then
    log "Smoke OK"
    rm -rf "$APP_PREV_OLD_DIR" || true
    exit 0
  fi
  log "等待服务就绪... (${i}/30)"
  sleep 2
done

die "smoke check failed after retries"
