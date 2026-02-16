#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REPO_ROOT="$repo_root" python3 - <<'PY'
from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Finding:
    rel_path: str
    line_no: int
    kind: str
    preview: str


def _redact_token(token: str) -> str:
    if len(token) <= 10:
        return "<REDACTED>"
    return token[:6] + "..." + token[-4:]


def main() -> int:
    repo_root = Path(os.environ.get("REPO_ROOT", ".")).resolve()

    exclude_suffixes = {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".ico",
        ".pdf",
        ".zip",
        ".tar",
        ".gz",
        ".tgz",
        ".xz",
        ".7z",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".mp4",
        ".dmg",
        ".exe",
        ".AppImage",
        ".deb",
        ".rpm",
    }

    max_bytes = 2_000_000

    re_example_invalid = re.compile(r"example\.invalid")
    re_private_lan_ip = re.compile(r"192\.168\.")
    re_openai_key = re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")

    allow_key_prefixes = (
        "server/tests/fixtures/",
        "server/tests/fixture/",
        "server/tests/data/",
    )

    findings: list[Finding] = []

    try:
        tracked_raw = subprocess.run(
            [
                "git",
                "-C",
                str(repo_root),
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ).stdout
    except Exception as e:
        print(f"scan_blockers: FAIL - cannot list tracked files via git: {e}")
        return 1

    tracked_paths = [p for p in tracked_raw.split(b"\x00") if p]

    for rel_b in tracked_paths:
        try:
            rel = rel_b.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            continue

        path = repo_root / rel
        if not path.exists():
            continue

        if path.suffix in exclude_suffixes:
            continue

        try:
            st = path.stat()
        except OSError:
            continue

        if st.st_size > max_bytes:
            continue

        try:
            raw = path.read_bytes()
        except OSError:
            continue

        text = raw.decode("utf-8", errors="ignore")
        if not text:
            continue

        lines = text.splitlines()

        for i, line in enumerate(lines, start=1):
            if re_example_invalid.search(line):
                findings.append(
                    Finding(
                        rel,
                        i,
                        "placeholder domain (example(dot)invalid)",
                        line.strip()[:200],
                    )
                )
            if re_private_lan_ip.search(line):
                findings.append(
                    Finding(
                        rel,
                        i,
                        "private LAN IP prefix (192(dot)168(dot))",
                        line.strip()[:200],
                    )
                )

        if rel.startswith(allow_key_prefixes):
            continue
        for m in re_openai_key.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            token = m.group(0)
            findings.append(
                Finding(
                    rel,
                    line_no,
                    "suspected OpenAI key (sk-...)",
                    _redact_token(token),
                )
            )

    if not findings:
        print("scan_blockers: OK")
        return 0

    print("scan_blockers: FAIL - blocked placeholders/secrets detected")
    for f in findings:
        print(f"- {f.rel_path}:{f.line_no}: {f.kind}: {f.preview}")
    print(
        "\nFix: remove placeholder domains, private LAN IPs, and leaked keys. Real secrets must come from local/server env vars or a gitignored .env."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
PY
