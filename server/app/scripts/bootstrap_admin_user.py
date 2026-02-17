from __future__ import annotations

import argparse
import os
import random
import secrets
import string
import sys
from dataclasses import dataclass
from typing import cast

from sqlalchemy import select
from sqlalchemy.exc import MultipleResultsFound
from sqlalchemy.orm import Session

from app.core.email import normalize_email
from app.core.security import hash_password, validate_password_policy
from app.db.models import AdminUser
from app.db.session import SessionLocal


PASSWORD_ENV_VAR = "BOOTSTRAP_ADMIN_PASSWORD"
BOOTSTRAP_MIN_PASSWORD_LEN = 12


@dataclass(frozen=True)
class PasswordResolution:
    password: str
    source: str
    generated: bool


def validate_bootstrap_password(password: str) -> None:
    if len(password) < BOOTSTRAP_MIN_PASSWORD_LEN:
        raise ValueError(f"password must be at least {BOOTSTRAP_MIN_PASSWORD_LEN} characters")
    validate_password_policy(password)


def generate_random_password(length: int = 20) -> str:
    if length < BOOTSTRAP_MIN_PASSWORD_LEN:
        raise ValueError("length too short")

    letters = string.ascii_letters
    digits = string.digits
    pool = letters + digits
    sysrand = random.SystemRandom()

    for _ in range(1000):
        chars: list[str] = [secrets.choice(letters), secrets.choice(digits)]
        chars.extend(secrets.choice(pool) for _ in range(length - 2))
        sysrand.shuffle(chars)
        password = "".join(chars)
        try:
            validate_bootstrap_password(password)
        except ValueError:
            continue
        return password

    raise RuntimeError("failed to generate a valid password")


def _read_password_from_stdin() -> str:
    raw = sys.stdin.read()
    if raw.endswith("\n"):
        raw = raw.rstrip("\r\n")
    return raw


def resolve_password(*, password_stdin: bool) -> PasswordResolution:
    if password_stdin:
        pw = _read_password_from_stdin()
        if pw == "":
            raise ValueError("--password-stdin was provided but stdin was empty")
        validate_bootstrap_password(pw)
        return PasswordResolution(password=pw, source="stdin", generated=False)

    env_pw = os.getenv(PASSWORD_ENV_VAR)
    if env_pw is not None and env_pw != "":
        validate_bootstrap_password(env_pw)
        return PasswordResolution(password=env_pw, source="env", generated=False)

    pw_gen = generate_random_password()
    return PasswordResolution(password=pw_gen, source="generated", generated=True)


def bootstrap_admin_user(
    db: Session,
    *,
    email: str,
    password: str,
    reset_password: bool,
    role: str | None,
    set_is_active: bool | None,
) -> tuple[AdminUser, str]:
    email_n = normalize_email(email)

    try:
        admin = db.execute(select(AdminUser).where(AdminUser.email == email_n)).scalar_one_or_none()
    except MultipleResultsFound as exc:
        raise RuntimeError(
            f"multiple admin users found for email={email_n!r}; please dedupe in DB"
        ) from exc

    if admin is None:
        validate_bootstrap_password(password)
        admin = AdminUser(
            email=email_n,
            password_hash=hash_password(password),
            role=(role or "super_admin"),
            is_active=(True if set_is_active is None else bool(set_is_active)),
        )
        db.add(admin)
        db.flush()
        return admin, "created"

    if role is not None:
        admin.role = role
    if set_is_active is not None:
        admin.is_active = bool(set_is_active)
    if reset_password:
        validate_bootstrap_password(password)
        admin.password_hash = hash_password(password)
    db.flush()
    return admin, "updated"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Create or reset the first admin user (idempotent). "
            "Password is read from env or stdin; otherwise a random one is generated."
        )
    )
    _ = parser.add_argument("--email", required=True, help="Admin email (will be normalized)")
    _ = parser.add_argument(
        "--role",
        default=None,
        help="Role to set (default on create: super_admin). If omitted on update, role is unchanged.",
    )
    _ = parser.add_argument(
        "--password-stdin",
        action="store_true",
        help=("Read password from stdin. Recommended to avoid putting plaintext in shell history."),
    )
    _ = parser.add_argument(
        "--reset-password",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Whether to reset password for an existing admin (default: true).",
    )

    active_group = parser.add_mutually_exclusive_group()
    _ = active_group.add_argument(
        "--set-active",
        dest="set_active",
        action="store_true",
        help="Set is_active=true (optional).",
    )
    _ = active_group.add_argument(
        "--set-inactive",
        dest="set_active",
        action="store_false",
        help="Set is_active=false (optional).",
    )
    parser.set_defaults(set_active=None)

    return parser


def main() -> None:
    args = _build_parser().parse_args()

    email = cast(str, args.email)
    role = cast(str | None, args.role)
    password_stdin = cast(bool, args.password_stdin)
    reset_password = cast(bool, args.reset_password)
    set_is_active = cast(bool | None, args.set_active)

    email_n = normalize_email(email)

    needs_password = True
    if reset_password is False:
        needs_password = False

    db = SessionLocal()
    try:
        try:
            existing = db.execute(
                select(AdminUser).where(AdminUser.email == email_n)
            ).scalar_one_or_none()
        except MultipleResultsFound as exc:
            raise RuntimeError(
                f"multiple admin users found for email={email_n!r}; please dedupe in DB"
            ) from exc
        if existing is None:
            needs_password = True

        pw_res: PasswordResolution | None = None
        if needs_password:
            pw_res = resolve_password(password_stdin=password_stdin)
        else:
            pw_res = PasswordResolution(password="", source="skipped", generated=False)

        admin, action = bootstrap_admin_user(
            db,
            email=email_n,
            password=pw_res.password,
            reset_password=reset_password,
            role=role,
            set_is_active=set_is_active,
        )
        db.commit()
        print(f"action={action} admin_user_id={admin.id} email={admin.email} role={admin.role}")
        if pw_res.generated:
            print("IMPORTANT: generated password printed once; please save it now")
            print(f"generated_password={pw_res.password}")
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        raise SystemExit(f"bootstrap_admin_user failed: {type(exc).__name__}: {exc}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
