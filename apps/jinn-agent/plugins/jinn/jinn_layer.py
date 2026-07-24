"""Subprocess wrapper around the ``jinn-layer`` CLI.

The Jinn layer is a package, not fork code (thin-fork discipline): scrubbing,
consent conversion, publishing, anchoring, the ledger and corpus reads all
live in ``jinn-layer``; this module only shells out to it. Resolve order:
the version-pinned plugin-local npm artifact, ``JINN_LAYER_BIN``, then
``jinn-layer`` on PATH. The last two are development overrides.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import harness

logger = logging.getLogger(__name__)

# The injected/test-double contract: a mock has no real OS-level stdout vs
# stderr split, so it returns one string. `_default_runner` (the real
# subprocess wrapper, below) genuinely has both streams and returns a
# 3-tuple; `run()`/`session_pickup()` normalize either shape to the 3-tuple
# every caller now sees (mono #1787).
Runner = Callable[..., Tuple[int, str]]
RuntimeInstaller = Callable[[List[str], Path], Tuple[int, str, str]]

_TIMEOUT_S = 120
_INSTALL_TIMEOUT_S = 300
CONTRACT_VERSION = 1
PROCESS_STATUSES = ("ok", "degraded", "unavailable")
_LAYER_PACKAGE = "@jinn-network/jinn-layer"
_LAYER_JS_ENTRYPOINT = "./dist/bin/jinn-layer.js"
_SEMVER_PIN = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


class LayerResolutionError(RuntimeError):
    """The committed plugin-local layer contract is malformed or unusable."""


@dataclass(frozen=True)
class LayerResolution:
    argv: tuple[str, ...]
    source: str
    detail: str
    package: str
    version: str


def _runtime_contract(plugin_dir: Path) -> tuple[str, str, str]:
    path = plugin_dir / "layer-runtime.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LayerResolutionError(
            f"invalid layer runtime contract at {path}: {exc}"
        ) from exc
    package = value.get("package") if isinstance(value, dict) else None
    version = value.get("version") if isinstance(value, dict) else None
    bin_path = value.get("bin") if isinstance(value, dict) else None
    if (
        package != _LAYER_PACKAGE
        or not isinstance(version, str)
        or _SEMVER_PIN.fullmatch(version) is None
        or not isinstance(bin_path, str)
        or not bin_path
    ):
        raise LayerResolutionError(f"invalid layer runtime contract at {path}")
    relative = Path(bin_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise LayerResolutionError(f"invalid layer runtime bin path at {path}")
    return package, version, bin_path


def _plugin_local_bin(plugin_dir: Path, bin_path: str) -> Path:
    """Locate npm's platform-specific shim for the committed bin contract."""
    local_bin = plugin_dir / bin_path
    if sys.platform == "win32":
        cmd_bin = Path(f"{local_bin}.cmd")
        if cmd_bin.exists():
            return cmd_bin
    return local_bin


def _plugin_local_resolution(
    local_bin: Path,
    package: str,
    version: str,
) -> LayerResolution:
    if not local_bin.is_file():
        raise LayerResolutionError(
            f"plugin-local layer artifact is not a file: {local_bin}"
        )
    if os.name != "nt" and sys.platform != "win32" and not os.access(local_bin, os.X_OK):
        raise LayerResolutionError(
            f"plugin-local layer artifact is not executable: {local_bin}"
        )
    installed_manifest = (
        local_bin.parent.parent
        / "@jinn-network"
        / "jinn-layer"
        / "package.json"
    )
    try:
        installed = json.loads(installed_manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LayerResolutionError(
            f"plugin-local layer package manifest is unreadable: "
            f"{installed_manifest}"
        ) from exc
    if (
        not isinstance(installed, dict)
        or installed.get("name") != package
        or installed.get("version") != version
    ):
        raise LayerResolutionError(
            f"plugin-local layer version mismatch: expected "
            f"{package}@{version} in {installed_manifest}"
        )

    if sys.platform == "win32":
        installed_bins = installed.get("bin")
        if (
            not isinstance(installed_bins, dict)
            or installed_bins.get("jinn-layer") != _LAYER_JS_ENTRYPOINT
        ):
            raise LayerResolutionError(
                f"plugin-local layer entrypoint mismatch in {installed_manifest}"
            )
        entrypoint = installed_manifest.parent / "dist" / "bin" / "jinn-layer.js"
        if not entrypoint.is_file():
            raise LayerResolutionError(
                f"plugin-local layer entrypoint is not a file: {entrypoint}"
            )
        node = shutil.which("node.exe")
        if node is None or not node.lower().endswith(".exe"):
            raise LayerResolutionError(
                "plugin-local layer requires node.exe on Windows"
            )
        return LayerResolution(
            argv=(node, str(entrypoint)),
            source="plugin-local",
            detail=f"plugin-local {package}@{version} ({entrypoint})",
            package=package,
            version=version,
        )

    return LayerResolution(
        argv=(str(local_bin),),
        source="plugin-local",
        detail=f"plugin-local {package}@{version} ({local_bin})",
        package=package,
        version=version,
    )


def resolve_binary(plugin_dir: Optional[Path] = None) -> LayerResolution:
    """Resolve the layer command and report which contract branch won."""
    directory = plugin_dir if plugin_dir is not None else Path(__file__).resolve().parent
    package, version, bin_path = _runtime_contract(directory)
    local_bin = _plugin_local_bin(directory, bin_path)
    if local_bin.exists():
        return _plugin_local_resolution(local_bin, package, version)
    override = (os.environ.get("JINN_LAYER_BIN") or "").strip()
    if override:
        if sys.platform == "win32" and not override.lower().endswith(".exe"):
            raise LayerResolutionError(
                "unsafe Windows JINN_LAYER_BIN override: use a native .exe, "
                "not a command shim"
            )
        return LayerResolution(
            argv=(override,),
            source="env",
            detail=f"JINN_LAYER_BIN={override} (development override)",
            package=package,
            version=version,
        )
    if sys.platform == "win32":
        raise LayerResolutionError(
            "plugin-local layer is unavailable on Windows; install the exact "
            "pinned runtime instead of invoking a PATH command shim"
        )
    return LayerResolution(
        argv=("jinn-layer",),
        source="path",
        detail="jinn-layer on PATH (development override)",
        package=package,
        version=version,
    )


def _default_runtime_installer(
    argv: List[str],
    cwd: Path,
) -> Tuple[int, str, str]:
    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=_INSTALL_TIMEOUT_S,
            check=False,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except FileNotFoundError:
        return 127, "", f"{argv[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{argv[0]}: timed out after {_INSTALL_TIMEOUT_S}s"


def ensure_plugin_runtime(
    plugin_dir: Optional[Path] = None,
    installer: RuntimeInstaller = _default_runtime_installer,
) -> LayerResolution:
    """Acquire the exact published layer for an installed slim plugin.

    An existing product artifact is validated first. Development overrides
    remain second and third in the resolution order and suppress acquisition
    when the plugin-local artifact is absent.
    """
    directory = plugin_dir if plugin_dir is not None else Path(__file__).resolve().parent
    package, version, bin_path = _runtime_contract(directory)
    local_bin = _plugin_local_bin(directory, bin_path)
    if local_bin.exists():
        try:
            return resolve_binary(directory)
        except LayerResolutionError:
            # A plugin update may advance the exact pin. npm repairs the
            # plugin-owned prefix; direct resolution still fails closed.
            pass

    if (os.environ.get("JINN_LAYER_BIN") or "").strip():
        return resolve_binary(directory)
    if sys.platform != "win32" and shutil.which("jinn-layer"):
        return resolve_binary(directory)

    npm = shutil.which("npm")
    if npm is None:
        raise LayerResolutionError(
            f"cannot install {package}@{version}: npm is not on PATH"
        )
    runtime_dir = directory / "runtime"
    if runtime_dir.is_symlink():
        raise LayerResolutionError(
            f"refusing plugin runtime symlink: {runtime_dir}"
        )
    argv = [
        npm,
        "install",
        "--prefix",
        str(runtime_dir),
        "--save-exact",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        f"{package}@{version}",
    ]
    code, out, err = installer(argv, directory)
    if code != 0:
        detail = (err or out or f"npm exited {code}").splitlines()[0]
        raise LayerResolutionError(
            f"failed to install {package}@{version}: {detail}"
        )
    return resolve_binary(directory)


def prepare_installed_plugin_runtime() -> Optional[LayerResolution]:
    """Bootstrap only a user-installed plugin checkout, never the mono tree."""
    directory = Path(__file__).resolve().parent
    hermes_home = Path(
        os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")
    )
    plugins_root = (hermes_home / "plugins").resolve()
    try:
        directory.resolve().relative_to(plugins_root)
    except ValueError:
        return None
    return ensure_plugin_runtime(directory)


def _default_runner(
    argv: List[str],
    cwd: Optional[str] = None,
    input: Optional[str] = None,
    timeout_s: int = _TIMEOUT_S,
) -> Tuple[int, str, str]:
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
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except FileNotFoundError:
        # The jinn-layer bin arrives with the plugin update; refresh it
        # (or set JINN_LAYER_BIN to point at a local build).
        return 127, "", (
            f"{argv[0]}: not found. Update the Jinn layer "
            f"({harness.cli_name()} plugins update jinn) or set JINN_LAYER_BIN."
        )
    except subprocess.TimeoutExpired:
        return 124, "", f"{argv[0]}: timed out after {timeout_s}s"


def binary() -> str:
    """Compatibility display value for the current single-executable command."""
    return resolve_binary().argv[0]


def _normalize_result(result: Tuple[int, str] | Tuple[int, str, str]) -> Tuple[int, str, str]:
    """A custom `Runner` returns `(code, out)`; `_default_runner` returns
    `(code, stdout, stderr)`. Every caller of `run()`/`session_pickup()` sees
    the 3-tuple regardless of which one produced it (mono #1787).

    Static checkers don't narrow a tuple union on `len()`, so the branches
    below are annotated explicitly rather than left to inference.
    """
    if len(result) == 3:
        return result  # type: ignore[return-value]
    code, out = result  # type: ignore[misc]
    return code, out, ""


def run(
    args: List[str],
    runner: Optional[Runner] = None,
    cwd: Optional[str] = None,
    input: Optional[str] = None,
    timeout_s: int = _TIMEOUT_S,
) -> Tuple[int, str, str]:
    argv = [*resolve_binary().argv, *args]
    if runner is not None:
        result = runner(argv, input=input) if input is not None else runner(argv)
        return _normalize_result(result)
    return _default_runner(argv, cwd, input, timeout_s=timeout_s)


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
            [*resolve_binary().argv, *args],
            stdout=out_f,
            stderr=err_f,
            stdin=subprocess.DEVNULL,
            **kwargs,
        )
    return proc.pid


# ── Verbs ────────────────────────────────────────────────────────────────────
# Every verb below is a thin `run()` wrapper, so each now returns
# `(code, stdout, stderr)` — no verb body changes, only the shared `run()`
# they call through (mono #1787).

def capture_preview(task_file: Path, runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    return run(["capture", "preview", str(task_file)], runner)


def ledger(runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    return run(["ledger"], runner)


def ledger_json(runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    """Structured ledger rows from the harness layer (residual outbound verb;
    the fork-side ledger surface was removed in mono#1818).

    Depends on ``jinn-layer ledger --json``. When the layer
    predates that flag it errors and the caller falls back to plain ``ledger``.
    """
    return run(["ledger", "--json"], runner)


def corpus_search(
    query: str,
    *,
    limit: int = 500,
    as_json: bool = True,
    runner: Optional[Runner] = None,
) -> Tuple[int, str, str]:
    """Corpus search. The CLI owns clamping ([1,500]) and ``""`` = all records.

    ``as_json`` emits ``--json`` (the layer prints ``JSON.stringify(hits)``,
    a JSON array); ``limit`` emits ``--limit N``. Keyword-only past ``query`` so
    the one production caller (``plugins/jinn/__init__.py``) that already passes
    ``runner=`` by keyword stays backward-compatible.
    """
    args = ["corpus", "search", query, "--limit", str(limit)]
    if as_json:
        args.append("--json")
    return run(args, runner)


def contract(
    runner: Optional[Runner] = None,
    *,
    timeout_s: int = _TIMEOUT_S,
) -> Tuple[int, str, str]:
    """Read the layer's versioned host/process contract."""
    return run(["contract", "--json"], runner, timeout_s=timeout_s)


def evidence_inspect_json(runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    """Read-only episode readability/count report for the full doctor."""
    return run(["reindex", "--dry-run", "--json"], runner)


def session_end(request: Dict[str, Any], runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    """Delegate one already-assembled EpisodeV1 through stdin."""
    payload = json.dumps(request, separators=(",", ":"))
    return run(["session", "end"], runner, input=payload)


# Pickup runs on the first turn, before the LLM call — tighter than the
# general 120s default (rescope plan §3.5): a broken jinn-layer must cost
# seconds, not the session. Only applies to the real subprocess runner; an
# injected test runner owns its own return timing.
_SESSION_PICKUP_TIMEOUT_S = 15


def session_pickup(request: Dict[str, Any], runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    """Delegate one first-turn evidence-pickup request through stdin
    (Stage 1 rescope R3) — the ``session end`` stdin-JSON pattern, applied
    to the sibling verb."""
    payload = json.dumps(request, separators=(",", ":"))
    argv = [*resolve_binary().argv, "session", "pickup"]
    if runner is not None:
        return _normalize_result(runner(argv, input=payload))
    return _default_runner(argv, input=payload, timeout_s=_SESSION_PICKUP_TIMEOUT_S)


def contribution_preview(
    *, acknowledge: bool = False, runner: Optional[Runner] = None
) -> Tuple[int, str, str]:
    args = ["contribution", "preview"]
    if acknowledge:
        args.append("--ack")
    args.append("--json")
    return run(args, runner)


def contribution_ledger_json(runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    return run(["contribution", "ledger", "--json"], runner)


def contribution_disable(runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    return run(["contribution", "disable", "--json"], runner)


def history_json(runner: Optional[Runner] = None) -> Tuple[int, str, str]:
    """Read history derived from canonical layer-owned evidence."""
    return run(["history", "--json"], runner)


def parse_process_response(raw: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("jinn-layer returned malformed JSON") from exc
    if not isinstance(parsed, dict) or parsed.get("contractVersion") != CONTRACT_VERSION:
        raise ValueError("jinn-layer response contract version mismatch")
    if parsed.get("status") not in PROCESS_STATUSES:
        raise ValueError("jinn-layer response has an invalid status")
    return parsed


def parse_session_end_response(raw: str) -> Dict[str, Any]:
    """Parse the outer v1 status envelope; reject transport/version drift."""
    return parse_process_response(raw)


def parse_session_pickup_response(raw: str) -> Dict[str, Any]:
    """Parse the outer v1 status envelope; reject transport/version drift."""
    return parse_process_response(raw)
