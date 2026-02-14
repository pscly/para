from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


# Import models so Alembic can discover them via Base.metadata.
from app.db import models as _models  # noqa: E402,F401
