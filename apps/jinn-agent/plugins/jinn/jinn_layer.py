"""Subprocess wrapper around the ``jinn-layer`` CLI (@jinn-network/harness-layer).

The Jinn layer is a package, not fork code (thin-fork discipline): scrubbing,
consent conversion, publishing, anchoring, the ledger and corpus reads all
live in ``jinn-layer``; this module only shells out to it. Resolve order:
``JINN_LAYER_BIN`` env, then ``jinn-layer`` on PATH.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

Runner = Callable[..., Tuple[int, str]]

_TIMEOUT_S = 120
CONTRACT_VERSION = 1


def _default_runner(
    argv: List[str],
    cwd: Optional[str] = None,
    input: Optional[str] = None,
    timeout_s: int = _TIMEOUT_S,
) -> Tuple[int, str]:
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            cwd=cwd,
            input=input,
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
        return 124, f"{argv[0]}: timed out after {timeout_s}s"


def binary() -> str:
    return (os.environ.get("JINN_LAYER_BIN") or "").strip() or "jinn-layer"


def run(
    args: List[str],
    runner: Optional[Runner] = None,
    cwd: Optional[str] = None,
    input: Optional[str] = None,
) -> Tuple[int, str]:
    argv = [binary(), *args]
    if runner is not None:
        return runner(argv, input=input) if input is not None else runner(argv)
    return _default_runner(argv, cwd, input)


def spawn(args: List[str], stdout_path: Path, stderr_path: Path) -> int:
    """Detached long-run launch (mono #1539) — NOT `_default_runner`.

    A distillation run takes minutes (one frontier call per cluster); the
    default runner's pipes + 120s timeout would kill it. File-redirected
    output (no pipe backpressure) and a new session (no SIGINT propagation
    from the TUI) let the child survive the harness exiting. POSIX-only
    detach; on win32 it degrades to a plain child process.
    """
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stderr_path.parent.mkdir(parents=True, exist_ok=True)
    kwargs: Dict[str, Any] = {}
    if sys.platform != "win32":
        kwargs["start_new_session"] = True
    with open(stdout_path, "ab") as out_f, open(stderr_path, "ab") as err_f:
        proc = subprocess.Popen(
            [binary(), *args],
            stdout=out_f,
            stderr=err_f,
            stdin=subprocess.DEVNULL,
            **kwargs,
        )
    return proc.pid


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


def corpus_search(
    query: str,
    *,
    limit: int = 500,
    as_json: bool = True,
    runner: Optional[Runner] = None,
) -> Tuple[int, str]:
    """Corpus search. The CLI owns clamping ([1,500]) and ``""`` = all records.

    ``as_json`` emits ``--json`` (harness-layer prints ``JSON.stringify(hits)``,
    a JSON array); ``limit`` emits ``--limit N``. Keyword-only past ``query`` so
    the one production caller (``plugins/jinn/__init__.py``) that already passes
    ``runner=`` by keyword stays backward-compatible.
    """
    args = ["corpus", "search", query, "--limit", str(limit)]
    if as_json:
        args.append("--json")
    return run(args, runner)


def contract(runner: Optional[Runner] = None) -> Tuple[int, str]:
    """Read the layer's versioned host/process contract."""
    return run(["contract", "--json"], runner)


def session_end(request: Dict[str, Any], runner: Optional[Runner] = None) -> Tuple[int, str]:
    """Delegate one already-assembled EpisodeV1 through stdin."""
    payload = json.dumps(request, separators=(",", ":"))
    return run(["session", "end"], runner, input=payload)


# Pickup runs on the first turn, before the LLM call — tighter than the
# general 120s default (rescope plan §3.5): a broken jinn-layer must cost
# seconds, not the session. Only applies to the real subprocess runner; an
# injected test runner owns its own return timing.
_SESSION_PICKUP_TIMEOUT_S = 15


def session_pickup(request: Dict[str, Any], runner: Optional[Runner] = None) -> Tuple[int, str]:
    """Delegate one first-turn evidence-pickup request through stdin
    (Stage 1 rescope R3) — the ``session end`` stdin-JSON pattern, applied
    to the sibling verb."""
    payload = json.dumps(request, separators=(",", ":"))
    argv = [binary(), "session", "pickup"]
    if runner is not None:
        return runner(argv, input=payload)
    return _default_runner(argv, input=payload, timeout_s=_SESSION_PICKUP_TIMEOUT_S)


def contribution_preview(
    *, acknowledge: bool = False, runner: Optional[Runner] = None
) -> Tuple[int, str]:
    args = ["contribution", "preview"]
    if acknowledge:
        args.append("--ack")
    args.append("--json")
    return run(args, runner)


def contribution_ledger_json(runner: Optional[Runner] = None) -> Tuple[int, str]:
    return run(["contribution", "ledger", "--json"], runner)


def contribution_disable(runner: Optional[Runner] = None) -> Tuple[int, str]:
    return run(["contribution", "disable", "--json"], runner)


def history_json(runner: Optional[Runner] = None) -> Tuple[int, str]:
    """Read history derived from canonical layer-owned evidence."""
    return run(["history", "--json"], runner)


def parse_process_response(raw: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("jinn-layer returned malformed JSON") from exc
    if not isinstance(parsed, dict) or parsed.get("contractVersion") != CONTRACT_VERSION:
        raise ValueError("jinn-layer response contract version mismatch")
    if parsed.get("status") not in ("ok", "degraded", "unavailable"):
        raise ValueError("jinn-layer response has an invalid status")
    return parsed


def parse_session_end_response(raw: str) -> Dict[str, Any]:
    """Parse the outer v1 status envelope; reject transport/version drift."""
    return parse_process_response(raw)


def parse_session_pickup_response(raw: str) -> Dict[str, Any]:
    """Parse the outer v1 status envelope; reject transport/version drift."""
    return parse_process_response(raw)


def write_task_file(task: Dict[str, Any], directory: Path, session_id: str) -> Path:
    """Atomically persist one private local CapturedTask."""
    if directory.is_symlink():
        raise OSError(f"unsafe capture directory symlink: {directory}")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    safe = (
        session_id
        if re.fullmatch(r"[A-Za-z0-9_-]{1,80}", session_id or "")
        else f"task-{hashlib.sha256(session_id.encode('utf-8')).hexdigest()}"
    )
    path = directory / f"{safe}.json"
    if os.path.lexists(path) and (path.is_symlink() or not path.is_file()):
        raise OSError(f"unsafe capture destination: {path}")

    descriptor = -1
    tmp_path: Optional[Path] = None
    try:
        descriptor, tmp_name = tempfile.mkstemp(
            prefix=f".{safe}.", suffix=".tmp", dir=directory
        )
        tmp_path = Path(tmp_name)
        os.fchmod(descriptor, 0o600)
        handle = os.fdopen(descriptor, "w", encoding="utf-8", newline="")
        descriptor = -1
        with handle:
            handle.write(json.dumps(task, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)
        return path
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
