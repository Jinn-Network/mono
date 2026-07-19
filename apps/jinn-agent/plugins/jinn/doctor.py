"""Plugin doctor — environment checks, output contract, first-session banner.

Print-only by design (spec 2026-07-17 §3.3): the doctor never executes a
fix; every failure carries exactly one copy-paste ``remedy`` command. A check
result is a plain dict ``{"name", "ok", "detail"}`` with ``"remedy"`` present
exactly when ``ok`` is false — the client CLI's shape
(``client/src/cli/commands/doctor.ts``).

Three call sites share one ``run_checks`` + one ``render``: the session-start
fast path (``full=False``), ``/jinn doctor``, and the ``jinn-doctor``
terminal verb (both ``full=True``).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

from . import consent
from . import jinn_layer

_UPDATE_REMEDY = "jinn-agent plugins update jinn"

# Minimum Node.js major for the layer mechanism — the cold-stock gate's own
# floor (scripts/cold-stock-e2e.sh), stricter than the client's >=20 check.
_NODE_FLOOR = 22

# A hung child (git index lock, credential helper, broken node shim) must not
# stall session start; the layer contract check receives this bound explicitly.
_SUBPROCESS_TIMEOUT_S = 10

# The bridge gate: only the layer handshake disables the additive session-end
# process bridge. plugin-build and prerequisites are reports, not gates.
_BRIDGE_GATING = {"layer-available", "layer-contract"}


def fail_lines(check: dict) -> list[str]:
    """The canonical two-line failure rendering — every surface uses this."""
    return [
        f"[fail] {check['name']}: {check['detail']}",
        f"       remedy: {check['remedy']}",
    ]


def _one_line(text: str, limit: int = 240) -> str:
    """Collapse raw subprocess output to one bounded line for ``detail``."""
    flattened = " ".join(text.split())
    return flattened if len(flattened) <= limit else flattened[: limit - 1] + "…"


def render(checks: list[dict]) -> str:
    """Human rendering mirroring the client CLI (doctor.ts humanDoctor)."""
    lines: list[str] = []
    blocking = 0
    for check in checks:
        if check["ok"]:
            lines.append(f"[ok  ] {check['name']}: {check['detail']}")
        else:
            blocking += 1
            lines.extend(fail_lines(check))
    lines.append(
        "all checks passed." if blocking == 0 else f"{blocking} blocking check(s) failed."
    )
    return "\n".join(lines)


def degraded_reason(checks: list[dict]) -> Optional[str]:
    """Bridge-degradation reason from a check run, or None when healthy.

    Only layer checks gate the bridge — a git hiccup in plugin-build or a
    Node-floor miss must not disable episode delegation while the layer
    handshake itself is fine.
    """
    for check in checks:
        if not check["ok"] and check["name"] in _BRIDGE_GATING:
            return check["detail"]
    return None


def _check_plugin_build(plugin_dir: Optional[Path] = None) -> dict:
    """Identity of the installed plugin dir — a report, not a gate."""
    directory = plugin_dir if plugin_dir is not None else Path(__file__).resolve().parent
    name = "plugin-build"
    if not (directory / ".git").exists():
        # Wheel / pip install: report the plugin.yaml version. Regex, not a
        # yaml import — upstream treats yaml as a best-effort dependency.
        version = "unknown"
        try:
            text = (directory / "plugin.yaml").read_text(encoding="utf-8")
            match = re.search(r'^version:\s*"?([^"\n]+)"?', text, re.MULTILINE)
            if match:
                version = match.group(1).strip()
        except OSError:
            pass
        return {"name": name, "ok": True, "detail": f"plugin.yaml version {version}"}
    try:
        head = subprocess.run(
            ["git", "-C", str(directory), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT_S,
        )
        status = subprocess.run(
            ["git", "-C", str(directory), "status", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT_S,
        )
        if head.returncode != 0 or status.returncode != 0:
            detail = _one_line(head.stderr or status.stderr or "git error")
            return {"name": name, "ok": False, "detail": detail, "remedy": _UPDATE_REMEDY}
        state = "dirty" if status.stdout.strip() else "clean"
        return {"name": name, "ok": True, "detail": f"git {head.stdout.strip()} ({state})"}
    except Exception as exc:
        return {"name": name, "ok": False, "detail": str(exc), "remedy": _UPDATE_REMEDY}


def _layer_resolution() -> tuple[str, str]:
    """(detail suffix, failure remedy) for the layer resolution in effect.

    Resolution order itself is untouched (issue C6) — this only reports it.
    """
    override = (os.environ.get("JINN_LAYER_BIN") or "").strip()
    if override:
        return (
            f"via JINN_LAYER_BIN={override}",
            "export JINN_LAYER_BIN=<path-to-client>/dist/bin/jinn-layer.js",
        )
    return "jinn-layer on PATH", _UPDATE_REMEDY


def _check_layer(runner: Optional[jinn_layer.Runner] = None) -> tuple[dict, dict]:
    """One ``contract --json`` spawn answering both layer checks."""
    resolution, remedy = _layer_resolution()
    not_checked = {
        "name": "layer-contract",
        "ok": False,
        "detail": "not checked — layer unavailable",
        "remedy": remedy,
    }
    try:
        code, out, err = jinn_layer.contract(
            runner=runner,
            timeout_s=_SUBPROCESS_TIMEOUT_S,
        )
    except Exception as exc:
        detail = f"jinn-layer handshake failed: {exc}"
        return (
            {"name": "layer-available", "ok": False, "detail": detail, "remedy": remedy},
            not_checked,
        )
    if code != 0:
        # The layer's remediation stderr is the actionable string — surface
        # it instead of discarding it (folded repair, spec §3.3), bounded to
        # one line so `/jinn status` and the fail line stay single-line.
        detail = _one_line(err or out or "") or f"jinn-layer exited {code}"
        return (
            {"name": "layer-available", "ok": False, "detail": detail, "remedy": remedy},
            not_checked,
        )
    available = {"name": "layer-available", "ok": True, "detail": resolution}
    try:
        reply = json.loads(out)
    except (TypeError, json.JSONDecodeError):
        reply = None
    if not isinstance(reply, dict):
        return available, {
            "name": "layer-contract",
            "ok": False,
            "detail": "contract reply unreadable",
            "remedy": remedy,
        }
    version = reply.get("contractVersion")
    if version != jinn_layer.CONTRACT_VERSION:
        return available, {
            "name": "layer-contract",
            "ok": False,
            "detail": f"contract v{version} (expected v{jinn_layer.CONTRACT_VERSION})",
            "remedy": remedy,
        }
    return available, {
        "name": "layer-contract",
        "ok": True,
        "detail": f"contract v{jinn_layer.CONTRACT_VERSION} ({resolution})",
    }


def _check_prerequisites() -> dict:
    """Node >= 22 — the layer mechanism's runtime floor."""
    name = "prerequisites"
    remedy = "brew install node@22" if sys.platform == "darwin" else "https://nodejs.org"
    node = shutil.which("node")
    if node is None:
        return {"name": name, "ok": False, "detail": "node not found on PATH", "remedy": remedy}
    try:
        proc = subprocess.run(
            [node, "--version"],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT_S,
        )
        version = proc.stdout.strip()
        major = int(version.lstrip("v").split(".")[0])
    except Exception:
        return {
            "name": name,
            "ok": False,
            "detail": "node --version unreadable",
            "remedy": remedy,
        }
    if major < _NODE_FLOOR:
        return {"name": name, "ok": False, "detail": version, "remedy": remedy}
    return {"name": name, "ok": True, "detail": version}


def _check_host_provider() -> dict:
    """Informational pointer — provider/credential sanity is the host's."""
    return {
        "name": "host-provider",
        "ok": True,
        "detail": "provider/credential sanity is owned by the host — run: jinn-agent doctor",
    }


# Full-run-only checks. A5's layer-side corpus probes (corpus-reachable /
# corpus-content) append here — the extension seam, nothing more.
_FULL_ONLY = [_check_host_provider]


def run_checks(full: bool, runner: Optional[jinn_layer.Runner] = None) -> list[dict]:
    checks = [
        _check_plugin_build(),
        *_check_layer(runner=runner),
        _check_prerequisites(),
    ]
    if full:
        checks.extend(fn() for fn in _FULL_ONLY)
    return checks


# ── First-session marker + banner ────────────────────────────────────────────


def _first_session_marker_path() -> Path:
    return consent.get_hermes_home() / "jinn" / "first-session-done"


def _first_session_done() -> bool:
    return _first_session_marker_path().exists()


def _mark_first_session_done() -> None:
    marker = _first_session_marker_path()
    try:
        marker.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.close(os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    except OSError:
        # FileExistsError: two racing session starts — the marker exists,
        # which is the goal. Anything else (read-only home, EACCES): the
        # banner repeats next session; never raise into the host session.
        pass


def first_session_banner(checks: list[dict]) -> list[str]:
    failing = [c for c in checks if not c["ok"]]
    if failing:
        verdict = fail_lines(failing[0])
    else:
        verdict = [f"jinn ready — {len(checks)} checks passed"]
    return [
        *verdict,
        'when a first message matches prior evidence you\'ll see a "◇ corpus" line'
        " — silence means nothing relevant yet",
        "commands: /jinn · re-check: /jinn doctor",
    ]


# ── Terminal entry point (``hermes jinn-doctor``) ────────────────────────────


def setup_parser(parser) -> None:
    """No flags — the doctor is print-only."""


def cli_handler(args) -> int:
    print(render(run_checks(full=True)))
    return 0
