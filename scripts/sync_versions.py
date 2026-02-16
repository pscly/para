#!/usr/bin/env python3
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import cast


_TAG_RE = re.compile(r"^v(?P<ver>0\.\d+\.\d+)$")
_VER_RE = re.compile(r"^(?P<major>0)\.(?P<minor>\d+)\.(?P<patch>\d+)$")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _parse_major0_semver(v: str) -> str | None:
    v = v.strip()
    if not v:
        return None
    if _VER_RE.fullmatch(v) is None:
        return None
    return v


def _maybe_tag_to_version(raw: str) -> str | None:
    s = raw.strip()
    if not s:
        return None

    if s.startswith("refs/tags/"):
        s = s.split("refs/tags/", 1)[1]

    m = _TAG_RE.fullmatch(s)
    if not m:
        return None
    return m.group("ver")


def _resolve_version_from_env() -> tuple[str | None, str | None]:
    keys = [
        "GITHUB_REF_NAME",
        "GITHUB_REF",
        "CI_COMMIT_TAG",
        "GIT_TAG",
        "TAG",
        "RELEASE_TAG",
    ]
    for k in keys:
        raw = os.getenv(k)
        if not raw:
            continue
        v = _maybe_tag_to_version(raw)
        if v:
            return v, f"env:{k}"
    return None, None


def _read_openapi_version(path: Path) -> str:
    raw = cast(object, json.loads(path.read_text(encoding="utf-8")))
    if not isinstance(raw, dict):
        raise SystemExit(f"{path} is not a JSON object")
    data = cast(dict[str, object], raw)
    info_obj = data.get("info")
    if not isinstance(info_obj, dict):
        raise SystemExit(f"{path} missing info")
    info = cast(dict[str, object], info_obj)
    v = info.get("version")
    if not isinstance(v, str) or not v.strip():
        raise SystemExit(f"{path} missing info.version")
    parsed = _parse_major0_semver(v)
    if not parsed:
        raise SystemExit(f"{path} has invalid info.version: {v!r}")
    return parsed


def _read_package_json_version(path: Path) -> str:
    raw = cast(object, json.loads(path.read_text(encoding="utf-8")))
    if not isinstance(raw, dict):
        raise SystemExit(f"{path} is not a JSON object")
    data = cast(dict[str, object], raw)
    v = data.get("version")
    if not isinstance(v, str) or not v.strip():
        raise SystemExit(f"{path} missing version")
    parsed = _parse_major0_semver(v)
    if not parsed:
        raise SystemExit(f"{path} has invalid version: {v!r}")
    return parsed


def _write_package_json_version(path: Path, version: str) -> None:
    raw = cast(object, json.loads(path.read_text(encoding="utf-8")))
    if not isinstance(raw, dict):
        raise SystemExit(f"{path} is not a JSON object")
    data = cast(dict[str, object], raw)
    data["version"] = version
    _ = path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _read_pyproject_version(path: Path) -> str:
    import tomllib

    data = cast(dict[str, object], tomllib.loads(path.read_text(encoding="utf-8")))
    project_obj = data.get("project")
    if not isinstance(project_obj, dict):
        raise SystemExit(f"{path} missing [project]")
    project = cast(dict[str, object], project_obj)
    v = project.get("version")
    if not isinstance(v, str) or not v.strip():
        raise SystemExit(f"{path} missing [project].version")
    parsed = _parse_major0_semver(v)
    if not parsed:
        raise SystemExit(f"{path} has invalid [project].version: {v!r}")
    return parsed


def _write_pyproject_version(path: Path, version: str) -> None:
    txt = path.read_text(encoding="utf-8")
    lines = txt.splitlines(keepends=True)

    in_project = False
    replaced = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_project = stripped == "[project]"
            continue
        if not in_project:
            continue

        m = re.match(r"^(?P<indent>\s*)version\s*=\s*\"[^\"]+\"\s*(?P<nl>\n?)$", line)
        if m:
            indent = m.group("indent")
            nl = "\n" if line.endswith("\n") else ""
            lines[i] = f'{indent}version = "{version}"{nl}'
            replaced = True
            break

    if not replaced:
        raise SystemExit(f"{path} could not find [project].version line to replace")

    _ = path.write_text("".join(lines), encoding="utf-8")


def _resolve_version(repo_root: Path, explicit: str | None) -> tuple[str, str]:
    if explicit is not None:
        parsed = _parse_major0_semver(explicit)
        if not parsed:
            raise SystemExit(
                f"--version must be major=0 semver like 0.x.y, got: {explicit!r}"
            )
        return parsed, "arg:--version"

    env_v, env_src = _resolve_version_from_env()
    if env_v and env_src:
        return env_v, env_src

    openapi_path = repo_root / "contracts" / "openapi.json"
    if openapi_path.exists():
        return _read_openapi_version(openapi_path), "file:contracts/openapi.json"

    pyproject_path = repo_root / "server" / "pyproject.toml"
    if pyproject_path.exists():
        return _read_pyproject_version(pyproject_path), "file:server/pyproject.toml"

    raise SystemExit("Unable to resolve version: no tag env and no local sources found")


def _export_openapi(repo_root: Path, version: str) -> None:
    server_dir = repo_root / "server"
    env = os.environ.copy()
    env["PARA_VERSION"] = version
    _ = subprocess.run(
        [
            "uv",
            "run",
            "python",
            "-m",
            "app.scripts.export_openapi",
            "--output",
            "../contracts/openapi.json",
        ],
        cwd=str(server_dir),
        env=env,
        check=True,
    )


def main() -> int:
    @dataclass(frozen=True)
    class Args:
        check: bool
        write: bool
        version: str | None
        export_openapi: bool
        print_version: bool

    p = argparse.ArgumentParser(
        description="Sync/check versions across server/client/admin-web/OpenAPI"
    )
    mode = p.add_mutually_exclusive_group()
    _ = mode.add_argument(
        "--check", action="store_true", help="Fail if versions are not aligned"
    )
    _ = mode.add_argument(
        "--write", action="store_true", help="Rewrite files to align versions"
    )
    _ = p.add_argument(
        "--version", help="Explicit version like 0.x.y (overrides tag/openapi)"
    )
    _ = p.add_argument(
        "--export-openapi",
        action="store_true",
        help="Export contracts/openapi.json via server exporter after syncing",
    )
    _ = p.add_argument(
        "--print", action="store_true", help="Print resolved version and exit"
    )

    ns = p.parse_args()
    check = bool(getattr(ns, "check", False))
    write = bool(getattr(ns, "write", False))
    export_openapi = bool(getattr(ns, "export_openapi", False))
    print_version = bool(getattr(ns, "print", False))
    version_raw = getattr(ns, "version", None)
    version_arg = (
        version_raw.strip()
        if isinstance(version_raw, str) and version_raw.strip()
        else None
    )

    if not check and not write:
        check = True

    args = Args(
        check=check,
        write=write,
        version=version_arg,
        export_openapi=export_openapi,
        print_version=print_version,
    )

    repo_root = _repo_root()
    version, src = _resolve_version(repo_root, args.version)

    if args.print_version:
        _ = sys.stdout.write(version + "\n")
        return 0

    client_pkg = repo_root / "client" / "package.json"
    admin_pkg = repo_root / "admin-web" / "package.json"
    pyproject = repo_root / "server" / "pyproject.toml"
    openapi = repo_root / "contracts" / "openapi.json"

    if args.write:
        _write_package_json_version(client_pkg, version)
        _write_package_json_version(admin_pkg, version)
        _write_pyproject_version(pyproject, version)
        if args.export_openapi:
            _export_openapi(repo_root, version)

    mismatches: list[str] = []
    if _read_package_json_version(client_pkg) != version:
        mismatches.append(f"{client_pkg}: version")
    if _read_package_json_version(admin_pkg) != version:
        mismatches.append(f"{admin_pkg}: version")
    if _read_pyproject_version(pyproject) != version:
        mismatches.append(f"{pyproject}: [project].version")
    if openapi.exists() and _read_openapi_version(openapi) != version:
        mismatches.append(f"{openapi}: info.version")

    if mismatches:
        joined = "\n".join(f"- {m}" for m in mismatches)
        raise SystemExit(
            f"Version mismatch (resolved {version} from {src}):\n"
            + joined
            + "\n"
            + "Tip: run ./scripts/sync_versions.py --write --export-openapi"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
