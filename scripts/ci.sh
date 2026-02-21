#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence_dir="$repo_root/.sisyphus/evidence"
evidence_file="$evidence_dir/task-24-ci.txt"

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
    printf '失败步骤: %s\n' "$step_name"
    printf '失败命令: %s\n' "$cmd_display"
    return 1
  fi

  step_marker "STEP OK" "$step_name"
}

do_contract_check() {
  cd "$repo_root"
  ./scripts/generate-contracts.sh --check
}

do_scan_blockers() {
  cd "$repo_root"
  ./scripts/scan_blockers.sh
}

do_server_tests() {
  cd "$repo_root"
  (cd server && uv run pytest)
}

do_client_tests() {
  cd "$repo_root"
  npm -C client test
}

do_client_lint() {
  cd "$repo_root"
  npm -C client run lint
}

run_all() {
  step_marker "TASK" "24 CI/本地一键验收脚本"
  printf 'Repo root: %s\n' "$repo_root"
  printf 'Evidence: %s\n' "$evidence_file"

  run_step "发布阻断扫描（占位符/泄露）" "./scripts/scan_blockers.sh" do_scan_blockers || return 1
  run_step "契约漂移检查（OpenAPI + TS 生成物）" "./scripts/generate-contracts.sh --check" do_contract_check || return 1
  run_step "Server 测试（pytest）" "(cd server && uv run pytest)" do_server_tests || return 1
  run_step "Client 类型检查（tsc）" "npm -C client run lint" do_client_lint || return 1
  run_step "Client 单测" "npm -C client test" do_client_tests || return 1

  step_marker "TASK" "ALL GREEN"
}

mkdir -p "$evidence_dir"

set +e
run_all 2>&1 | tee "$evidence_file"
rc=${PIPESTATUS[0]}
set -e

exit "$rc"
