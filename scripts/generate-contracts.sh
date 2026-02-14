#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/generate-contracts.sh [--check]

Actions:
  - Export FastAPI OpenAPI to contracts/openapi.json
  - Generate TS types into client/src/gen

Options:
  --check   Fail if generated outputs drift from git
EOF
}

check=0
if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  usage
  exit 0
fi
if [[ ${1:-} == "--check" ]]; then
  check=1
elif [[ -n ${1:-} ]]; then
  echo "Unknown argument: ${1}" >&2
  usage >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p contracts

(cd server && uv run python -m app.scripts.export_openapi --output ../contracts/openapi.json)
npm -C client run gen:api

if [[ $check -eq 1 ]]; then
  generated_status="$(git status --porcelain -- contracts/openapi.json client/src/gen)"
  if [[ -n "$generated_status" ]]; then
    echo "Generated outputs are not clean (untracked/modified)." >&2
    echo "Run ./scripts/generate-contracts.sh and commit the results." >&2
    echo >&2
    echo "$generated_status" >&2
    exit 1
  fi
fi
