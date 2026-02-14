#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence_dir="$repo_root/.sisyphus/evidence"
evidence_file="$evidence_dir/task-25-qa-alpha.txt"

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

do_ci() {
  cd "$repo_root"
  ./scripts/ci.sh
}

do_e2e() {
  cd "$repo_root"
  npm -C client run e2e -- \
    electron-login.spec.ts \
    electron-chat-stream.spec.ts \
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
    "task-17-gallery.png"
    "task-15-vision-suggestion.png"
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

  run_step "CI (contracts + server pytest + client unit)" "./scripts/ci.sh" do_ci || return 1
  run_step "Client E2E (Playwright Electron)" "npm -C client run e2e -- electron-{login,chat-stream,feed-knowledge,gallery,timeline,pet-ui,vision-screenshot,assistant-suggest,plugin,admin-flag}.spec.ts" do_e2e || return 1
  run_step "Evidence validation" "count>=10 + required files exist" validate_evidence || return 1

  step_marker "TASK" "ALL GREEN"
}

mkdir -p "$evidence_dir"

set +e
run_all 2>&1 | tee "$evidence_file"
rc=${PIPESTATUS[0]}
set -e

exit "$rc"
