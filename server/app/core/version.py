from __future__ import annotations

import os
import re
from pathlib import Path
from typing import cast


_SEMVER_RE = re.compile(r"^(?P<major>0)\.(?P<minor>\d+)\.(?P<patch>\d+)$")


def _is_valid_major0_semver(v: str) -> bool:
    return _SEMVER_RE.match(v.strip()) is not None


def _read_pyproject_version() -> str | None:
    try:
        import tomllib
    except Exception:
        return None

    pyproject_path = Path(__file__).resolve().parents[2] / "pyproject.toml"
    if not pyproject_path.exists():
        return None

    try:
        data = cast(dict[str, object], tomllib.loads(pyproject_path.read_text(encoding="utf-8")))
        project_obj = data.get("project")
        if not isinstance(project_obj, dict):
            return None
        project = cast(dict[str, object], project_obj)
        v = project.get("version")
        if isinstance(v, str) and v.strip():
            return v.strip()
    except Exception:
        return None

    return None


def _read_dist_version() -> str | None:
    try:
        from importlib import metadata

        return metadata.version("para-server")
    except Exception:
        return None


def get_app_version() -> str:
    env_v = os.getenv("PARA_VERSION")
    if isinstance(env_v, str) and env_v.strip():
        v = env_v.strip()
        if _is_valid_major0_semver(v):
            return v

    for candidate in (_read_pyproject_version(), _read_dist_version()):
        if isinstance(candidate, str) and candidate.strip() and _is_valid_major0_semver(candidate):
            return candidate.strip()

    return "0.0.0"
