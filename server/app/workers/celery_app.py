# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownParameterType=false
from __future__ import annotations

import os

from celery import Celery
from celery.schedules import crontab


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    val = raw.strip().lower()
    if val in {"1", "true", "yes", "on"}:
        return True
    if val in {"0", "false", "no", "off"}:
        return False
    return default


def create_celery_app() -> Celery:
    broker_url = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    result_backend = os.getenv("CELERY_RESULT_BACKEND", broker_url)

    app = Celery("para", broker=broker_url, backend=result_backend)

    app.conf.task_always_eager = _env_bool("CELERY_TASK_ALWAYS_EAGER", False)
    app.conf.task_eager_propagates = _env_bool("CELERY_TASK_EAGER_PROPAGATES", True)

    app.conf.timezone = os.getenv("CELERY_TIMEZONE", "UTC")
    app.conf.enable_utc = True
    app.conf.accept_content = ["json"]
    app.conf.task_serializer = "json"
    app.conf.result_serializer = "json"

    app.autodiscover_tasks(["app.workers"], related_name="tasks")

    dev_every_minute = _env_bool("CELERY_BEAT_DEV_EVERY_MINUTE", True)
    if dev_every_minute:
        app.conf.beat_schedule = {
            "task-12-dreams-periodic-tick": {
                "task": "app.workers.tasks.dreams.task_12_generate_dreams_for_all_saves",
                "schedule": crontab(minute="*/1"),
                "args": (),
            }
        }

    return app


celery_app = create_celery_app()
