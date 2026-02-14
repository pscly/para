from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import cast

from app.main import app


def export_openapi(output_path: Path) -> None:
    schema = app.openapi()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _ = output_path.write_text(
        json.dumps(schema, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Export FastAPI OpenAPI schema as JSON")
    _ = parser.add_argument(
        "--output",
        default="contracts/openapi.json",
        help="Output path (relative to current working directory)",
    )
    args = parser.parse_args()

    export_openapi(Path(cast(str, args.output)))


if __name__ == "__main__":
    main()
