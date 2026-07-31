"""Print-only environment checks.

The contract, re-instantiated from the onboarding design for this architecture:
every check is ``{name, ok, detail, remedy}``; ``remedy`` is exactly one
copy-paste command on every failure, and is ``None`` exactly when the break is
not fixable from this machine (spec 9.3) - a channel outage, or a runtime check
the runtime itself reported with a null remedy. The doctor never executes a fix.

Three call sites share one ``run_checks``: the session-start fast path
(``full=False``), ``/jinn doctor``, and the ``hermes jinn-doctor`` terminal verb.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import host_config
from . import mcp_client
from . import paths
from . import runtime_pin

NODE_FLOOR = 22
_SUBPROCESS_TIMEOUT_S = 10
_HEALTH_TIMEOUT_S = 15.0

UPDATE_REMEDY = "hermes plugins update jinn"
REMOVE_ENTRY_REMEDY = "remove the mcp_servers.jinn block from ~/.hermes/config.yaml"
MCP_EXTRA_REMEDY = "pip install 'hermes-agent[mcp]'"

# Only the runtime gates the product. A stale checkout or a Node hint is a
# report; silencing capture and pickup over either would be a worse failure than
# the one being reported.
_GATING = {"runtime-available"}


def _one_line(text: str, limit: int = 240) -> str:
    flattened = " ".join(str(text).split())
    return flattened if len(flattened) <= limit else flattened[: limit - 1] + "..."


def _check(name: str, ok: bool, detail: str, remedy: Optional[str] = None) -> Dict[str, Any]:
    return {"name": name, "ok": ok, "detail": _one_line(detail), "remedy": remedy}


# -- individual checks ------------------------------------------------------


def check_plugin_build(directory: Optional[Path] = None) -> Dict[str, Any]:
    """Identity of the installed adapter. A report, not a gate."""
    target = directory if directory is not None else paths.plugin_dir()
    if not (target / ".git").exists():
        version = "unknown"
        try:
            text = (target / "plugin.yaml").read_text(encoding="utf-8")
            match = re.search(r'^version:\s*"?([^"\n]+)"?', text, re.MULTILINE)
            if match:
                version = match.group(1).strip()
        except OSError:
            pass
        return _check("plugin-build", True, f"plugin.yaml version {version}")
    try:
        head = subprocess.run(
            ["git", "-C", str(target), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT_S, check=False,
        )
        status = subprocess.run(
            ["git", "-C", str(target), "status", "--porcelain"],
            capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT_S, check=False,
        )
        if head.returncode != 0 or status.returncode != 0:
            return _check("plugin-build", False, head.stderr or status.stderr or "git error", UPDATE_REMEDY)
        state = "dirty" if status.stdout.strip() else "clean"
        return _check("plugin-build", True, f"git {head.stdout.strip()} ({state})")
    except Exception as exc:
        return _check("plugin-build", False, str(exc), UPDATE_REMEDY)


def check_runtime_pin() -> Dict[str, Any]:
    """The pin file itself, read without a Node toolchain."""
    try:
        pin = runtime_pin.read_pin()
    except runtime_pin.RuntimePinError as exc:
        return _check("runtime-pin", False, str(exc), UPDATE_REMEDY)
    return _check("runtime-pin", True, f"{pin.package}@{pin.version}")


def _resolve_runtime():
    """Resolve without acquiring: the doctor reports, it never installs."""
    return runtime_pin.resolve()


def _client_for_checks() -> "mcp_client.McpClient":
    resolution = _resolve_runtime()
    return mcp_client.spawn_session_client(
        resolution, paths.runtime_home(), timeout_s=_HEALTH_TIMEOUT_S
    )


def check_runtime_available(client_factory: Optional[Callable[[], Any]] = None) -> Dict[str, Any]:
    """Start the pinned runtime, complete the handshake, and call ``health``."""
    try:
        resolution = _resolve_runtime()
    except runtime_pin.ChannelOutageError as exc:
        # Not fixable from this machine: printing an update command here would
        # send a user round a loop that cannot close (spec 9.3).
        return _check("runtime-available", False, str(exc), None)
    except runtime_pin.RuntimePinError as exc:
        return _check("runtime-available", False, str(exc), UPDATE_REMEDY)

    factory = client_factory or _client_for_checks
    try:
        with factory() as client:
            client.call_tool("health", {})
    except mcp_client.McpClientError as exc:
        return _check("runtime-available", False, f"{exc.code}: {exc.detail}", UPDATE_REMEDY)
    except Exception as exc:
        return _check("runtime-available", False, str(exc), UPDATE_REMEDY)
    return _check("runtime-available", True, resolution.detail)


def check_prerequisites() -> Dict[str, Any]:
    """Node >= 22: the runtime's floor, and npm's."""
    remedy = "brew install node@22" if sys.platform == "darwin" else "https://nodejs.org"
    node = shutil.which("node")
    if node is None:
        return _check("prerequisites", False, "node not found on PATH", remedy)
    try:
        completed = subprocess.run(
            [node, "--version"], capture_output=True, text=True,
            timeout=_SUBPROCESS_TIMEOUT_S, check=False,
        )
        version = completed.stdout.strip()
        major = int(version.lstrip("v").split(".")[0])
    except Exception:
        return _check("prerequisites", False, "node --version unreadable", remedy)
    if major < NODE_FLOOR:
        return _check("prerequisites", False, f"{version} (need >= v{NODE_FLOOR})", remedy)
    return _check("prerequisites", True, version)


def check_host_tools() -> Dict[str, Any]:
    """The host's own MCP plumbing: the model-facing half of the seam."""
    entry = host_config.read_entry()
    if not isinstance(entry, dict):
        return _check(
            "host-tools",
            False,
            "the corpus tools are not registered with this host",
            "start a session with the plugin enabled, or run: hermes jinn-doctor",
        )
    command = str(entry.get("command") or "")
    if command and not Path(command).exists():
        return _check(
            "host-tools",
            False,
            f"mcp_servers.jinn points at {command}, which no longer exists",
            REMOVE_ENTRY_REMEDY,
        )
    try:
        import mcp  # noqa: F401
    except ImportError:
        return _check(
            "host-tools",
            False,
            "this host cannot connect MCP servers, so corpus_search and corpus_fetch "
            "are unavailable to the agent; capture and first-turn pickup are unaffected",
            MCP_EXTRA_REMEDY,
        )
    return _check("host-tools", True, "corpus_search and corpus_fetch registered with the host")


def _runtime_checks(client_factory: Optional[Callable[[], Any]] = None) -> List[Dict[str, Any]]:
    """The runtime's own report, merged verbatim. Null remedies survive."""
    factory = client_factory or _client_for_checks
    try:
        with factory() as client:
            report = client.call_tool("health", {})
    except Exception as exc:
        return [_check("runtime-health", False, f"the runtime could not report: {exc}", UPDATE_REMEDY)]
    checks = report.get("checks")
    if not isinstance(checks, list):
        return [_check("runtime-health", False, "the runtime returned an unreadable report", UPDATE_REMEDY)]
    merged: List[Dict[str, Any]] = []
    for check in checks:
        if not isinstance(check, dict) or not isinstance(check.get("name"), str):
            continue
        remedy = check.get("remedy")
        merged.append(
            _check(
                check["name"],
                bool(check.get("ok")),
                str(check.get("detail") or ""),
                remedy if isinstance(remedy, str) and remedy else None,
            )
        )
    return merged


# -- composition ------------------------------------------------------------


def run_checks(full: bool, client_factory: Optional[Callable[[], Any]] = None) -> List[Dict[str, Any]]:
    checks = [
        check_plugin_build(),
        check_runtime_pin(),
        check_runtime_available(client_factory=client_factory),
        check_prerequisites(),
    ]
    if full:
        checks.append(check_host_tools())
        checks.extend(_runtime_checks(client_factory=client_factory))
    return checks


def degraded_reason(checks: List[Dict[str, Any]]) -> Optional[str]:
    for check in checks:
        if not check["ok"] and check["name"] in _GATING:
            return check["detail"]
    return None


# -- terminal entry point (``hermes jinn-doctor``) --------------------------


def setup_parser(parser) -> None:
    """No flags. The doctor is print-only; there is nothing to configure."""


def cli_handler(args) -> int:
    from . import view

    print(view.render_checks(run_checks(full=True)))
    return 0
