"""Subprocess wrapper around the ``jinn-layer`` CLI (@jinn-network/harness-layer).

The Jinn layer is a package, not fork code (thin-fork discipline): scrubbing,
consent conversion, publishing, anchoring, the ledger and corpus reads all
live in ``jinn-layer``; this module only shells out to it. Resolve order:
``JINN_LAYER_BIN`` env, then ``jinn-layer`` on PATH.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

Runner = Callable[[List[str]], Tuple[int, str]]

_TIMEOUT_S = 120


def _default_runner(argv: List[str]) -> Tuple[int, str]:
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
            check=False,
        )
        out = proc.stdout + (("\n" + proc.stderr) if proc.stderr.strip() else "")
        return proc.returncode, out.strip()
    except FileNotFoundError:
        # The jinn-layer bin ships on the canary tag until the next stable
        # release (>= 0.1.10) carries it — flip @canary back to bare
        # @jinn-network/client here and in README.md once that stable ships
        # (see Jinn-Network/mono#1368).
        return 127, (
            f"{argv[0]}: not found. Install the Jinn layer "
            "(npm install -g @jinn-network/client@canary) or set JINN_LAYER_BIN."
        )
    except subprocess.TimeoutExpired:
        return 124, f"{argv[0]}: timed out after {_TIMEOUT_S}s"


def binary() -> str:
    return (os.environ.get("JINN_LAYER_BIN") or "").strip() or "jinn-layer"


def run(args: List[str], runner: Optional[Runner] = None) -> Tuple[int, str]:
    return (runner or _default_runner)([binary(), *args])


# ── Verbs ────────────────────────────────────────────────────────────────────

def capture_preview(task_file: Path, runner: Optional[Runner] = None) -> Tuple[int, str]:
    return run(["capture", "preview", str(task_file)], runner)


def publish(task_file: Path, veto: bool = False, runner: Optional[Runner] = None) -> Tuple[int, str]:
    args = ["publish", str(task_file)]
    if veto:
        args.append("--veto")
    return run(args, runner)


def ledger(runner: Optional[Runner] = None) -> Tuple[int, str]:
    return run(["ledger"], runner)


def ledger_json(runner: Optional[Runner] = None) -> Tuple[int, str]:
    """Structured ledger rows for the fork-side renderer (ledger_view).

    Depends on ``jinn-layer ledger --json`` (harness-layer). When the layer
    predates that flag it errors and the caller falls back to plain ``ledger``.
    """
    return run(["ledger", "--json"], runner)


def corpus_search(query: str, runner: Optional[Runner] = None) -> Tuple[int, str]:
    return run(["corpus", "search", query], runner)


def write_task_file(task: Dict[str, Any], directory: Path, session_id: str) -> Path:
    """Persist the assembled CapturedTask for preview/publish/retry."""
    directory.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in session_id)[:80]
    path = directory / f"{safe or 'task'}.json"
    path.write_text(json.dumps(task, indent=2) + "\n", encoding="utf-8")
    return path
