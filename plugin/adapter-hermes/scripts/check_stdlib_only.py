"""Fail the build if the adapter grows a third-party import.

The adapter runs inside a cloned plugin directory with no dependency install.
An import that is not in the standard library, not a sibling module, and not a
lazily-imported Hermes module is a runtime crash on a stock install.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ADAPTER = Path(__file__).resolve().parent.parent
PERMITTED_TOP_LEVEL = set(sys.stdlib_module_names)
# Host-supplied modules, permitted only inside a function body (lazy import).
# `mcp` is here because the doctor probes for it to decide whether the host can
# serve the model-facing tools at all; it is an optional Hermes extra
# (hermes-agent[mcp]) and is never imported for the adapter's own work.
HOST_MODULES = {"hermes_cli", "hermes_constants", "utils", "tools", "mcp"}

failures: list[str] = []

for path in sorted(ADAPTER.glob("*.py")):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    module_level = {id(node) for node in tree.body}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level > 0:
            continue  # relative sibling import
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module.split(".")[0]]
        for name in names:
            if name in PERMITTED_TOP_LEVEL:
                continue
            if name in HOST_MODULES and id(node) not in module_level:
                continue
            if name in HOST_MODULES:
                failures.append(f"{path.name}: host module {name!r} imported at module level")
                continue
            failures.append(f"{path.name}: third-party import {name!r}")

if failures:
    for failure in failures:
        print(failure)
    raise SystemExit(1)
print(f"adapter import boundary clean ({len(list(ADAPTER.glob('*.py')))} modules)")
