"""Feature 19, T-1910 (design.md 决策 4/F-1917).

Writes this service's OWN OpenAPI schema (from the live FastAPI app object
— never hand-written) to `openapi.json` at the package root. Run as
`uv run python scripts/export_openapi.py` from `services/dispatch-rerank/`.

CI (and this repo's own review discipline) treats the checked-in
`openapi.json` as a generated artifact: re-running this script must
produce byte-identical output, or the contract has drifted without the
generated file being updated — the CI job runs this script and fails the
build on any diff, the same "regenerate and diff, don't hand-edit"
discipline `apps/api`'s own `generate-rerank-types` script applies on the
Node side of this same contract.
"""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402


def main() -> None:
    schema = app.openapi()
    output_path = pathlib.Path(__file__).resolve().parent.parent / "openapi.json"
    output_path.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"OpenAPI schema written to {output_path}")


if __name__ == "__main__":
    main()
