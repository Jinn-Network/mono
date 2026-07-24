#!/usr/bin/env python3
"""Merge per-slice test duration artifacts into one cache file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_path", type=Path)
    args = parser.parse_args()

    paths = sorted(args.input_dir.glob("**/test_durations.json"))
    if not paths:
        parser.error(f"no test_durations.json files found under {args.input_dir}")

    merged: dict[str, float] = {}
    for path in paths:
        with path.open(encoding="utf-8") as file:
            merged.update(json.load(file))

    args.output_path.parent.mkdir(parents=True, exist_ok=True)
    args.output_path.write_text(
        json.dumps(merged, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        f"Merged {len(merged)} file durations from {len(paths)} artifacts "
        f"-> {args.output_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
