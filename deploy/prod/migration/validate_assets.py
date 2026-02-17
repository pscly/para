#!/usr/bin/env python3
"""资产一致性校验：从 DB 抽样并检查磁盘可读（默认要求 DB path 在 /app/.data 下）。"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit, urlunsplit


def redact_dsn(dsn: str) -> str:
    if not dsn:
        return ""
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", dsn):
        try:
            parts = urlsplit(dsn)
            netloc = parts.netloc
            if "@" in netloc and ":" in netloc.split("@", 1)[0]:
                userinfo, hostinfo = netloc.split("@", 1)
                user, _pw = userinfo.split(":", 1)
                netloc = f"{user}:***@{hostinfo}"
            return urlunsplit(
                (parts.scheme, netloc, parts.path, parts.query, parts.fragment)
            )
        except Exception:
            return dsn
    return re.sub(r"(password=)(\S+)", r"\1***", dsn)


def run_psql(dsn: str, sql: str) -> list[tuple[str, ...]]:
    cmd = [
        "psql",
        dsn,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-A",
        "-t",
        "-F",
        "\t",
        "-c",
        sql,
    ]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"psql_failed rc={proc.returncode}")
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    rows: list[tuple[str, ...]] = []
    for ln in lines:
        rows.append(tuple(ln.split("\t")))
    return rows


@dataclass(frozen=True)
class AssetRef:
    kind: str
    asset_id: str
    db_path: str


def map_db_path_to_fs(
    *, db_path: str, assets_root: Path, db_path_prefix: str
) -> tuple[Path | None, str]:
    p = db_path.strip()
    if not p:
        return None, "empty"

    root = assets_root.resolve()
    prefix = db_path_prefix.strip()
    if prefix.lower() in {"*", "any"}:
        if not p.startswith("/app/.data/"):
            return None, "prefix_mismatch"
        suffix = p[len("/app/.data/") :]
        cand = (root / suffix).resolve()
        try:
            _ = cand.relative_to(root)
        except Exception:
            return None, "path_escape"
        return cand, "ok"

    prefix = prefix.rstrip("/")
    if not prefix:
        return None, "invalid_prefix"

    wanted = prefix + "/"
    if not p.startswith(wanted):
        return None, "prefix_mismatch"

    suffix = p[len(wanted) :]
    if not suffix:
        return None, "empty_suffix"

    cand = (root / suffix).resolve()
    try:
        _ = cand.relative_to(root)
    except Exception:
        return None, "path_escape"
    return cand, "ok"


def check_readable_file(path: Path) -> str | None:
    if not path.exists():
        return "missing"
    if not path.is_file():
        return "not_file"
    try:
        with path.open("rb") as f:
            _ = f.read(1)
    except Exception:
        return "unreadable"
    return None


def check_readable_dir(path: Path) -> str | None:
    if not path.exists():
        return "missing"
    if not path.is_dir():
        return "not_dir"
    try:
        _ = list(path.iterdir())
    except Exception:
        return "unreadable"
    return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    _ = ap.add_argument(
        "--db", dest="db_dsn", default=os.getenv("DST_DATABASE_URL", "")
    )
    _ = ap.add_argument("--assets-root", default=os.getenv("DST_ASSETS_DIR", ""))
    _ = ap.add_argument(
        "--db-path-prefix",
        default=os.getenv("ASSETS_DB_PATH_PREFIX", "/app/.data"),
        help="要求 DB path 必须在该前缀之下（默认 /app/.data；可通过 any/* 放宽但仍要求 /app/.data）",
    )
    _ = ap.add_argument(
        "--sample-n", type=int, default=int(os.getenv("ASSETS_SAMPLE_N", "50"))
    )
    args = ap.parse_args(argv)

    db_dsn = cast(str, getattr(args, "db_dsn", ""))
    assets_root_arg = cast(str, getattr(args, "assets_root", ""))
    sample_n = int(cast(int, getattr(args, "sample_n", 50)))

    if not db_dsn:
        print("ERROR: missing --db (or DST_DATABASE_URL)", file=sys.stderr)
        return 2
    if not assets_root_arg:
        print("ERROR: missing --assets-root (or DST_ASSETS_DIR)", file=sys.stderr)
        return 2

    assets_root = Path(assets_root_arg).expanduser().resolve()
    db_path_prefix = cast(str, getattr(args, "db_path_prefix", "/app/.data"))
    print("validate_assets=1")
    print(f"db_dsn={redact_dsn(db_dsn)}")
    print(f"assets_root={assets_root}")
    print(f"db_path_prefix={db_path_prefix}")
    print(f"sample_n={sample_n}")

    queries: list[tuple[str, str]] = [
        (
            "knowledge_materials",
            "SELECT id, storage_path FROM knowledge_materials WHERE storage_path <> '' ORDER BY random() LIMIT "
            + str(sample_n)
            + ";",
        ),
        (
            "ugc_assets",
            "SELECT id, storage_path FROM ugc_assets WHERE storage_path <> '' ORDER BY random() LIMIT "
            + str(sample_n)
            + ";",
        ),
        (
            "gallery_items",
            "SELECT id, storage_dir FROM gallery_items WHERE status='completed' AND storage_dir <> '' ORDER BY random() LIMIT "
            + str(sample_n)
            + ";",
        ),
    ]

    refs: list[AssetRef] = []
    for kind, sql in queries:
        try:
            rows = run_psql(db_dsn, sql)
        except Exception as e:
            print(
                f"ERROR: query_failed kind={kind} detail={type(e).__name__}",
                file=sys.stderr,
            )
            return 1
        for r in rows:
            if len(r) < 2:
                continue
            refs.append(AssetRef(kind=kind, asset_id=r[0], db_path=r[1]))

    if not refs:
        print("assets_refs=0")
        print("validate_assets_ok=1")
        return 0

    failures: list[str] = []
    checked = 0
    for ref in refs:
        checked += 1
        mapped, reason = map_db_path_to_fs(
            db_path=ref.db_path,
            assets_root=assets_root,
            db_path_prefix=db_path_prefix,
        )
        if mapped is None:
            failures.append(
                f"unmapped kind={ref.kind} id={ref.asset_id} reason={reason} db_path={ref.db_path}"
            )
            continue

        if ref.kind == "gallery_items":
            err = check_readable_dir(mapped)
            if err is not None:
                failures.append(
                    f"bad_dir kind={ref.kind} id={ref.asset_id} path={mapped} reason={err}"
                )
                continue
            thumb = mapped / "thumb.png"
            image = mapped / "image.png"
            if not thumb.exists() and not image.exists():
                failures.append(
                    f"missing_files kind={ref.kind} id={ref.asset_id} path={mapped} reason=no_thumb_or_image"
                )
                continue
            for p in (thumb, image):
                if p.exists():
                    e2 = check_readable_file(p)
                    if e2 is not None:
                        failures.append(
                            f"bad_file kind={ref.kind} id={ref.asset_id} path={p} reason={e2}"
                        )
        else:
            err = check_readable_file(mapped)
            if err is not None:
                failures.append(
                    f"bad_file kind={ref.kind} id={ref.asset_id} path={mapped} reason={err}"
                )

    print(f"assets_checked={checked}")
    print(f"assets_failures={len(failures)}")
    if failures:
        for ln in failures[:50]:
            print(f"FAIL\t{ln}")
        print("ERROR: assets_validation_failed", file=sys.stderr)
        return 1

    print("validate_assets_ok=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
