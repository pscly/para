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

resolve_tag_version() {
  local raw=""
  if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
    raw="${GITHUB_REF_NAME}"
  elif [[ -n "${CI_COMMIT_TAG:-}" ]]; then
    raw="${CI_COMMIT_TAG}"
  elif [[ -n "${GITHUB_REF:-}" ]]; then
    raw="${GITHUB_REF}"
  fi

  if [[ -z "$raw" ]]; then
    return 0
  fi

  raw="${raw#refs/tags/}"
  if [[ "$raw" =~ ^v0\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s' "${raw#v}"
  fi
}

if [[ -z "${PARA_VERSION:-}" ]]; then
  tag_v="$(resolve_tag_version)"
  if [[ -n "$tag_v" ]]; then
    export PARA_VERSION="$tag_v"
  fi
fi

if [[ $check -eq 1 ]]; then
  before_status="$(git status --porcelain -- contracts/openapi.json client/src/gen)"

  (cd server && uv run python -m app.scripts.export_openapi --output ../contracts/openapi.json)
  npm -C client run gen:api

  after_status="$(git status --porcelain -- contracts/openapi.json client/src/gen)"
  if [[ "$after_status" != "$before_status" ]]; then
    echo "Generated outputs drifted after regeneration." >&2
    echo "Run ./scripts/generate-contracts.sh (without --check) and commit the results." >&2
    echo >&2
    echo "Before:" >&2
    echo "$before_status" >&2
    echo >&2
    echo "After:" >&2
    echo "$after_status" >&2
    exit 1
  fi
  exit 0
fi

(cd server && uv run python -m app.scripts.export_openapi --output ../contracts/openapi.json)
npm -C client run gen:api
