#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence_dir="$repo_root/.sisyphus/evidence"
evidence_file="$evidence_dir/task-25-qa-alpha.txt"

compose_project=""
postgres_port=""
redis_port=""
started_deps=0
cleanup_ran=0

step_marker() {
  local kind="$1"
  local name="$2"
  printf '\n========== [%s] %s ==========%s' "$kind" "$name" $'\n'
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

need_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || {
    printf 'ERROR: missing_required_command=%s\n' "$name" >&2
    return 1
  }
}

pick_free_ports_2() {
  python3 - <<'PY'
import socket

ports = []
socks = []
for _ in range(2):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    socks.append(s)
    ports.append(s.getsockname()[1])
for s in socks:
    s.close()
print(" ".join(str(p) for p in ports))
PY
}

dc() {
  COMPOSE_PROJECT_NAME="$compose_project" POSTGRES_PORT="$postgres_port" REDIS_PORT="$redis_port" \
    docker compose -p "$compose_project" --project-directory "$repo_root" -f docker-compose.yml --env-file .env.example "$@"
}

wait_deps_healthy() {
  local pg_id
  local redis_id
  pg_id="$(dc ps -q postgres)"
  redis_id="$(dc ps -q redis)"

  if [[ -z "$pg_id" || -z "$redis_id" ]]; then
    printf 'ERROR: failed_to_resolve_container_ids\n' >&2
    dc ps >&2 || true
    return 1
  fi

  for i in {1..60}; do
    local pg_health
    local redis_health
    pg_health="$(docker inspect -f '{{.State.Health.Status}}' "$pg_id" 2>/dev/null || true)"
    redis_health="$(docker inspect -f '{{.State.Health.Status}}' "$redis_id" 2>/dev/null || true)"

    if [[ "$pg_health" == "healthy" && "$redis_health" == "healthy" ]]; then
      printf 'deps_healthy=1\n'
      return 0
    fi

    printf 'waiting_for_deps postgres=%s redis=%s attempt=%s/60\n' "$pg_health" "$redis_health" "$i"
    sleep 2
  done

  printf 'ERROR: deps_not_healthy_in_time\n' >&2
  dc ps >&2 || true
  return 1
}

ensure_deps_env() {
  local has_db=0
  local has_broker=0
  local has_ws=0

  [[ -n "${DATABASE_URL:-}" ]] && has_db=1
  [[ -n "${CELERY_BROKER_URL:-}" ]] && has_broker=1
  [[ -n "${WS_REDIS_URL:-}" ]] && has_ws=1

  if (( has_db == 1 && has_broker == 1 && has_ws == 1 )); then
    step_marker "ENV" "Using existing deps env"
    printf 'DATABASE_URL=%s\n' "$DATABASE_URL"
    printf 'CELERY_BROKER_URL=%s\n' "$CELERY_BROKER_URL"
    printf 'WS_REDIS_URL=%s\n' "$WS_REDIS_URL"
    return 0
  fi

  if (( has_db == 0 && has_broker == 0 && has_ws == 0 )); then
    need_cmd docker
    need_cmd python3

    compose_project="para-qa-alpha-$$-$(date +%s)"
    read -r postgres_port redis_port < <(pick_free_ports_2)
    if [[ -z "$postgres_port" || -z "$redis_port" ]]; then
      printf 'ERROR: failed_to_pick_free_ports\n' >&2
      return 1
    fi

    step_marker "DEPS" "Start Postgres+Redis (isolated compose project)"
    printf 'compose_project=%s\n' "$compose_project"
    printf 'postgres_port=%s\n' "$postgres_port"
    printf 'redis_port=%s\n' "$redis_port"

    dc up -d postgres redis
    wait_deps_healthy

    export DATABASE_URL="postgresql+psycopg://para:para@127.0.0.1:${postgres_port}/para"
    export CELERY_BROKER_URL="redis://127.0.0.1:${redis_port}/0"
    export WS_REDIS_URL="redis://127.0.0.1:${redis_port}/0"

    started_deps=1
    return 0
  fi

  printf 'ERROR: partial_deps_env_detected\n' >&2
  printf 'Set all of DATABASE_URL/CELERY_BROKER_URL/WS_REDIS_URL, or set none (qa_alpha will start deps).\n' >&2
  printf 'DATABASE_URL_set=%s\n' "$has_db" >&2
  printf 'CELERY_BROKER_URL_set=%s\n' "$has_broker" >&2
  printf 'WS_REDIS_URL_set=%s\n' "$has_ws" >&2
  return 1
}

cleanup() {
  if (( cleanup_ran == 1 )); then
    return 0
  fi
  cleanup_ran=1

  if (( started_deps == 1 )) && [[ -n "$compose_project" ]]; then
    step_marker "CLEANUP" "docker compose down -v"
    dc down -v || true
  fi
}

do_ci() {
  cd "$repo_root"
  ./scripts/ci.sh
}

do_e2e() {
  cd "$repo_root"
  npm -C client run e2e -- \
    --workers=1 \
    electron-login.spec.ts \
    electron-userdata-migration.spec.ts \
    electron-chat-stream.spec.ts \
    electron-byok-chat.spec.ts \
    electron-feed-knowledge.spec.ts \
    electron-gallery.spec.ts \
    electron-timeline.spec.ts \
    electron-pet-ui.spec.ts \
    electron-vision-screenshot.spec.ts \
    electron-assistant-suggest.spec.ts \
    electron-plugin.spec.ts \
    electron-admin-flag.spec.ts
}

validate_evidence() {
  local min_count=10

  local -a required_files=(
    "task-24-ci.txt"
    "task-25-qa-alpha.txt"
    "task-5-auth-flow.txt"
    "task-9-save-isolation.txt"
    "task-11-memory-search.json"
    "task-13-knowledge-query.json"
    "task-10-pet-ui.png"
    "task-14-userdata-migrate.png"
    "task-14-userdata-migrate-fail.png"
    "task-17-gallery.png"
    "task-15-vision-suggestion.png"
    "task-15-byok.png"
    "task-16-assistant-suggest.png"
    "task-18-timeline.txt"
    "task-18-timeline.png"
    "task-21-plugin.png"
    "task-22-admin-flag.png"
    "task-6-login-success.png"
  )

  local -a missing=()
  local f
  for f in "${required_files[@]}"; do
    if [[ ! -f "$evidence_dir/$f" ]]; then
      missing+=("$f")
    fi
  done

  shopt -s nullglob
  local -a evidence_files=("$evidence_dir"/*.json "$evidence_dir"/*.png "$evidence_dir"/*.txt)
  shopt -u nullglob
  local evidence_count="${#evidence_files[@]}"

  step_marker "EVIDENCE" "证据清单/计数"
  printf 'evidence_dir=%s\n' "$evidence_dir"
  printf 'evidence_count=%s (min=%s)\n' "$evidence_count" "$min_count"

  if (( evidence_count > 0 )); then
    local -a basenames=()
    local p
    for p in "${evidence_files[@]}"; do
      basenames+=("$(basename "$p")")
    done
    printf '%s\n' "${basenames[@]}" | LC_ALL=C sort
  fi

  if (( evidence_count < min_count )); then
    printf '\nERROR: evidence_count_too_low count=%s min=%s\n' "$evidence_count" "$min_count"
    return 1
  fi

  if (( ${#missing[@]} > 0 )); then
    printf '\nERROR: missing_required_evidence_files=%s\n' "${#missing[@]}"
    printf '%s\n' "${missing[@]}" | LC_ALL=C sort
    return 1
  fi

  return 0
}

run_all() {
  step_marker "TASK" "25 Alpha E2E QA Runner"
  printf 'repo_root=%s\n' "$repo_root"
  printf 'evidence_file=%s\n' "$evidence_file"

  trap cleanup EXIT INT TERM

  run_step "Deps env" "ensure deps env (auto-start docker compose if unset)" ensure_deps_env || return 1

  run_step "CI (contracts + server pytest + client unit)" "./scripts/ci.sh" do_ci || return 1
  run_step "Client E2E (Playwright Electron)" "npm -C client run e2e -- --workers=1 electron-{login,userdata-migration,chat-stream,byok-chat,feed-knowledge,gallery,timeline,pet-ui,vision-screenshot,assistant-suggest,plugin,admin-flag}.spec.ts" do_e2e || return 1
  run_step "Evidence validation" "count>=10 + required files exist" validate_evidence || return 1

  step_marker "TASK" "ALL GREEN"
}

mkdir -p "$evidence_dir"

set +e
run_all 2>&1 | tee "$evidence_file"
rc=${PIPESTATUS[0]}
set -e

exit "$rc"
