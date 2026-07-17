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

_UPDATE_REMEDY = "hermes plugins update jinn"

# Minimum Node.js major for the layer mechanism — the cold-stock gate's own
# floor (scripts/cold-stock-e2e.sh), stricter than the client's >=20 check.
_NODE_FLOOR = 22


def render(checks: list[dict]) -> str:
    """Human rendering mirroring the client CLI (doctor.ts humanDoctor)."""
    lines: list[str] = []
    blocking = 0
    for check in checks:
        mark = "ok  " if check["ok"] else "fail"
        lines.append(f"[{mark}] {check['name']}: {check['detail']}")
        if not check["ok"]:
            blocking += 1
            lines.append(f"       remedy: {check['remedy']}")
    lines.append(
        "all checks passed." if blocking == 0 else f"{blocking} blocking check(s) failed."
    )
    return "\n".join(lines)


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
        )
        status = subprocess.run(
            ["git", "-C", str(directory), "status", "--porcelain"],
            capture_output=True,
            text=True,
        )
        if head.returncode != 0 or status.returncode != 0:
            detail = (head.stderr or status.stderr or "git error").strip()
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
        code, out, err = jinn_layer.contract(runner=runner)
    except Exception as exc:
        detail = f"jinn-layer handshake failed: {exc}"
        return (
            {"name": "layer-available", "ok": False, "detail": detail, "remedy": remedy},
            not_checked,
        )
    if code != 0:
        # The layer's remediation stderr is the actionable string — surface
        # it instead of discarding it (folded repair, spec §3.3).
        detail = (err or out or "").strip() or f"jinn-layer exited {code}"
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
        proc = subprocess.run([node, "--version"], capture_output=True, text=True)
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
        "detail": "provider/credential sanity is owned by the host — run: hermes doctor",
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
    marker.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.close(os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    except FileExistsError:
        # Two racing session starts — the marker exists, which is the goal.
        pass


def first_session_banner(checks: list[dict]) -> list[str]:
    failing = [c for c in checks if not c["ok"]]
    if failing:
        first = failing[0]
        verdict = [
            f"[fail] {first['name']}: {first['detail']}",
            f"       remedy: {first['remedy']}",
        ]
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
