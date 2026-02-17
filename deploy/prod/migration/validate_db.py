#!/usr/bin/env python3
"""DB 一致性校验：通过 psql 运行 SQL 输出 TSV 报告（DSN 脱敏）。"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
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


def run_psql(
    dsn: str,
    sql: str,
    *,
    timeout_s: float | None = None,
    statement_timeout_ms: int | None = None,
) -> str:
    env = os.environ.copy()

    if statement_timeout_ms is not None:
        prev = env.get("PGOPTIONS", "")
        opt = f"-c statement_timeout={int(statement_timeout_ms)}"
        env["PGOPTIONS"] = (prev + " " + opt).strip() if prev else opt

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
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("psql_timeout")

    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"psql_failed rc={proc.returncode}")
    return proc.stdout.strip()


def table_exists(dsn: str, table: str) -> bool:
    out = run_psql(dsn, f"SELECT to_regclass('public.{table}') IS NOT NULL;")
    return out.strip().lower() in {"t", "true", "1"}


def parse_tables_arg(s: str) -> list[str]:
    items: list[str] = []
    for raw in s.split(","):
        t = raw.strip()
        if not t:
            continue
        if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", t):
            raise ValueError(f"invalid_table_name={t}")
        items.append(t)
    return items


DEFAULT_TABLES = [
    "users",
    "devices",
    "refresh_tokens",
    "saves",
    "timeline_events",
    "memory_items",
    "memory_embeddings",
    "knowledge_materials",
    "knowledge_chunks",
    "ugc_assets",
    "gallery_items",
    "plugin_packages",
    "audit_logs",
    "admin_users",
    "admin_kv",
]


@dataclass(frozen=True)
class RowcountResult:
    table: str
    method: str
    value: int


def rowcount_exact(dsn: str, table: str, timeout_ms: int) -> int:
    sql = f"SELECT count(*)::bigint FROM public.{table};"
    out = run_psql(dsn, sql, statement_timeout_ms=timeout_ms)
    return int(out.strip() or "0")


def rowcount_estimate_reltuples(dsn: str, table: str) -> int:
    sql = f"SELECT COALESCE(reltuples::bigint, 0) FROM pg_class WHERE oid = ('public.{table}'::regclass);"
    out = run_psql(dsn, sql)
    return int(out.strip() or "0")


def get_rowcount(dsn: str, table: str, timeout_ms: int) -> RowcountResult:
    if not table_exists(dsn, table):
        return RowcountResult(table=table, method="missing", value=0)

    try:
        v = rowcount_exact(dsn, table, timeout_ms)
        return RowcountResult(table=table, method="exact", value=v)
    except Exception:
        v = rowcount_estimate_reltuples(dsn, table)
        return RowcountResult(table=table, method="estimate_reltuples", value=v)


@dataclass(frozen=True)
class OrphanCheck:
    name: str
    required_tables: tuple[str, ...]
    sql: str


ORPHAN_CHECKS: list[OrphanCheck] = [
    OrphanCheck(
        name="saves.user_id -> users.id",
        required_tables=("saves", "users"),
        sql="SELECT count(*)::bigint FROM saves s LEFT JOIN users u ON u.id=s.user_id WHERE u.id IS NULL;",
    ),
    OrphanCheck(
        name="devices.user_id -> users.id",
        required_tables=("devices", "users"),
        sql="SELECT count(*)::bigint FROM devices d LEFT JOIN users u ON u.id=d.user_id WHERE u.id IS NULL;",
    ),
    OrphanCheck(
        name="refresh_tokens.user_id -> users.id",
        required_tables=("refresh_tokens", "users"),
        sql="SELECT count(*)::bigint FROM refresh_tokens rt LEFT JOIN users u ON u.id=rt.user_id WHERE u.id IS NULL;",
    ),
    OrphanCheck(
        name="refresh_tokens.device_id -> devices.id",
        required_tables=("refresh_tokens", "devices"),
        sql="SELECT count(*)::bigint FROM refresh_tokens rt LEFT JOIN devices d ON d.id=rt.device_id WHERE d.id IS NULL;",
    ),
    OrphanCheck(
        name="memory_items.save_id -> saves.id",
        required_tables=("memory_items", "saves"),
        sql="SELECT count(*)::bigint FROM memory_items mi LEFT JOIN saves s ON s.id=mi.save_id WHERE s.id IS NULL;",
    ),
    OrphanCheck(
        name="memory_embeddings.memory_id -> memory_items.id",
        required_tables=("memory_embeddings", "memory_items"),
        sql="SELECT count(*)::bigint FROM memory_embeddings me LEFT JOIN memory_items mi ON mi.id=me.memory_id WHERE mi.id IS NULL;",
    ),
    OrphanCheck(
        name="knowledge_materials.save_id -> saves.id",
        required_tables=("knowledge_materials", "saves"),
        sql="SELECT count(*)::bigint FROM knowledge_materials km LEFT JOIN saves s ON s.id=km.save_id WHERE s.id IS NULL;",
    ),
    OrphanCheck(
        name="knowledge_chunks.material_id -> knowledge_materials.id",
        required_tables=("knowledge_chunks", "knowledge_materials"),
        sql="SELECT count(*)::bigint FROM knowledge_chunks kc LEFT JOIN knowledge_materials km ON km.id=kc.material_id WHERE km.id IS NULL;",
    ),
    OrphanCheck(
        name="knowledge_chunks.save_id -> saves.id",
        required_tables=("knowledge_chunks", "saves"),
        sql="SELECT count(*)::bigint FROM knowledge_chunks kc LEFT JOIN saves s ON s.id=kc.save_id WHERE s.id IS NULL;",
    ),
    OrphanCheck(
        name="gallery_items.save_id -> saves.id",
        required_tables=("gallery_items", "saves"),
        sql="SELECT count(*)::bigint FROM gallery_items gi LEFT JOIN saves s ON s.id=gi.save_id WHERE s.id IS NULL;",
    ),
    OrphanCheck(
        name="ugc_assets.uploaded_by_user_id -> users.id",
        required_tables=("ugc_assets", "users"),
        sql="SELECT count(*)::bigint FROM ugc_assets ua LEFT JOIN users u ON u.id=ua.uploaded_by_user_id WHERE u.id IS NULL;",
    ),
    OrphanCheck(
        name="ugc_assets.reviewed_by -> admin_users.id",
        required_tables=("ugc_assets", "admin_users"),
        sql=(
            "SELECT count(*)::bigint "
            "FROM ugc_assets ua "
            "LEFT JOIN admin_users au ON au.id=ua.reviewed_by "
            "WHERE ua.reviewed_by IS NOT NULL AND au.id IS NULL;"
        ),
    ),
    OrphanCheck(
        name="plugin_packages.reviewed_by -> admin_users.id",
        required_tables=("plugin_packages", "admin_users"),
        sql=(
            "SELECT count(*)::bigint "
            "FROM plugin_packages pp "
            "LEFT JOIN admin_users au ON au.id=pp.reviewed_by "
            "WHERE pp.reviewed_by IS NOT NULL AND au.id IS NULL;"
        ),
    ),
]


def check_pgvector(dsn: str) -> bool:
    sql = "SELECT 1 FROM pg_extension WHERE extname='vector' LIMIT 1;"
    out = run_psql(dsn, sql)
    return out.strip() == "1"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    _ = ap.add_argument(
        "--src", dest="src_dsn", default=os.getenv("SRC_DATABASE_URL", "")
    )
    _ = ap.add_argument(
        "--dst", dest="dst_dsn", default=os.getenv("DST_DATABASE_URL", "")
    )
    _ = ap.add_argument(
        "--tables",
        default=os.getenv("VALIDATE_TABLES", ""),
        help="逗号分隔表名，覆盖默认表清单",
    )
    _ = ap.add_argument(
        "--rowcount-timeout-ms",
        type=int,
        default=int(os.getenv("ROWCOUNT_TIMEOUT_MS", "3000")),
    )
    _ = ap.add_argument(
        "--max-diff",
        type=int,
        default=int(os.getenv("ROWCOUNT_MAX_DIFF", "0")),
        help="允许的行数差异阈值（abs(src-dst) <= max_diff 视为通过；默认 0）",
    )
    _ = ap.add_argument(
        "--require-exact",
        action="store_true",
        default=bool(int(os.getenv("ROWCOUNT_REQUIRE_EXACT", "0"))),
        help="若任一关键表 rowcount 只能用 estimate_reltuples 获取，则视为失败",
    )
    args = ap.parse_args(argv)

    dst_arg = cast(str, getattr(args, "dst_dsn", ""))
    if not dst_arg:
        print("ERROR: missing --dst (or DST_DATABASE_URL)", file=sys.stderr)
        return 2

    src_dsn = cast(str, getattr(args, "src_dsn", "")).strip()
    dst_dsn = dst_arg.strip()

    tables = DEFAULT_TABLES
    tables_arg = cast(str, getattr(args, "tables", ""))
    if tables_arg.strip():
        try:
            tables = parse_tables_arg(tables_arg)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 2

    print("validate_db=1")
    print(f"src_dsn={redact_dsn(src_dsn) if src_dsn else '<unset>'}")
    print(f"dst_dsn={redact_dsn(dst_dsn)}")
    rowcount_timeout_ms = int(cast(int, getattr(args, "rowcount_timeout_ms", 3000)))
    print(f"rowcount_timeout_ms={rowcount_timeout_ms}")
    rowcount_max_diff = int(cast(int, getattr(args, "max_diff", 0)))
    rowcount_require_exact = bool(getattr(args, "require_exact", False))
    print(f"rowcount_max_diff={rowcount_max_diff}")
    print(f"rowcount_require_exact={int(rowcount_require_exact)}")
    print(f"tables={','.join(tables)}")

    try:
        dst_has_vec = check_pgvector(dst_dsn)
    except Exception as e:
        print(
            f"ERROR: dst_pgvector_check_failed detail={type(e).__name__}",
            file=sys.stderr,
        )
        return 1
    print(f"dst_pgvector_extension_present={int(dst_has_vec)}")
    if not dst_has_vec:
        print("ERROR: dst_missing_pgvector_extension ext=vector", file=sys.stderr)
        return 1

    if src_dsn:
        try:
            src_has_vec = check_pgvector(src_dsn)
        except Exception:
            src_has_vec = False
        print(f"src_pgvector_extension_present={int(src_has_vec)}")

    mismatches = 0
    estimate_used_tables = 0
    for t in tables:
        dst_rc = get_rowcount(dst_dsn, t, rowcount_timeout_ms)
        if src_dsn:
            src_rc = get_rowcount(src_dsn, t, rowcount_timeout_ms)
            if src_rc.method == "missing" or dst_rc.method == "missing":
                ok = False
                diff_s = "na"
                mismatches += 1
            else:
                if src_rc.method != "exact" or dst_rc.method != "exact":
                    estimate_used_tables += 1
                diff = abs(src_rc.value - dst_rc.value)
                diff_s = str(diff)

                if rowcount_require_exact and (
                    src_rc.method != "exact" or dst_rc.method != "exact"
                ):
                    ok = False
                    mismatches += 1
                elif src_rc.method == "exact" and dst_rc.method == "exact":
                    ok = diff <= rowcount_max_diff
                    if not ok:
                        mismatches += 1
                else:
                    ok = True
            print(
                "rowcount\t"
                + f"table={t}\t"
                + f"src={src_rc.value}\t(src_method={src_rc.method})\t"
                + f"dst={dst_rc.value}\t(dst_method={dst_rc.method})\t"
                + f"diff={diff_s}\t"
                + f"ok={int(ok)}"
            )
        else:
            print(
                "rowcount\t"
                + f"table={t}\t"
                + f"dst={dst_rc.value}\t(dst_method={dst_rc.method})"
            )

    orphan_total = 0
    for chk in ORPHAN_CHECKS:
        missing = [t for t in chk.required_tables if not table_exists(dst_dsn, t)]
        if missing:
            print(
                "orphan\t"
                + f"check={chk.name}\t"
                + f"skipped=missing_tables:{','.join(missing)}"
            )
            continue

        try:
            out = run_psql(dst_dsn, chk.sql)
            cnt = int(out.strip() or "0")
        except Exception:
            cnt = -1
        if cnt != 0:
            orphan_total += 1
        print(f"orphan\tcheck={chk.name}\tcount={cnt}")

    if src_dsn:
        print(f"rowcount_estimate_used_tables={estimate_used_tables}")

    if src_dsn and mismatches != 0:
        print(f"ERROR: rowcount_mismatch_tables={mismatches}", file=sys.stderr)
        return 1
    if orphan_total != 0:
        print(f"ERROR: orphan_checks_failed={orphan_total}", file=sys.stderr)
        return 1

    print("validate_db_ok=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
