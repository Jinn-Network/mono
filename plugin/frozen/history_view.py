"""Pure terminal renderer for history derived by the canonical Jinn layer."""

from __future__ import annotations

from datetime import datetime
import re
from typing import Any, Dict, Iterable, List

from . import style

_ANSI_SEQUENCE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def safe_text(value: object, fallback: str = "unavailable") -> str:
    if not isinstance(value, str) or not value.strip():
        return fallback
    return style.sanitise(_ANSI_SEQUENCE.sub("", value.strip()))


def _time(value: object) -> str:
    raw = safe_text(value, "")
    if not raw:
        return "unknown time"
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw
    return parsed.strftime("%m-%d %H:%M")


def _knowledge(entry: Dict[str, Any]) -> str:
    # knowledgeSurfaced/knowledgeUsed are the wire field names (unchanged);
    # their meaning is searched/provided counts as of the rescope (§3.6).
    searched = entry.get("knowledgeSurfaced")
    provided = entry.get("knowledgeUsed")
    if not isinstance(searched, int) or not isinstance(provided, int):
        return "knowledge unavailable"
    return f"knowledge searched {searched} · provided {provided}"


def _eligibility(value: object) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("eligible"), bool):
        return "eligibility unavailable"
    label = "eligible" if value["eligible"] else "not eligible"
    reason = safe_text(value.get("reason"), "")
    return f"eligibility {label}" + (f" — {reason}" if reason else "")


def _contribution(value: object) -> str:
    if not isinstance(value, dict):
        return "contribution unavailable"
    status = safe_text(value.get("status"), "unavailable")
    line = f"contribution {status}"
    anchor = safe_text(value.get("anchorRef"), "")
    return line + (f" · {anchor}" if anchor else "")


def _skills(value: object) -> List[str]:
    if value is None:
        return ["local skills unavailable"]
    if not isinstance(value, list):
        return ["local skills unavailable"]
    if not value:
        return ["local skills none"]

    labels: List[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        ref = safe_text(item.get("ref"), "")
        state = safe_text(item.get("state"), "unavailable")
        if ref.startswith("local-skill:"):
            ref = ref[len("local-skill:") :]
        if ref:
            labels.append(f"{ref} ({state})")
    return ["local skills " + ", ".join(labels)] if labels else ["local skills unavailable"]


def render_history(entries: Iterable[Dict[str, Any]]) -> str:
    """Render canonical session history without inventing missing facts."""
    rows = [entry for entry in entries if isinstance(entry, dict)]
    if not rows:
        return (
            "No Jinn sessions captured yet. Complete ordinary work with Jinn "
            "enabled to build local history."
        )

    pal, rst = style.palette()
    title = style.wrap(
        pal,
        rst,
        "fg",
        f"Jinn history · {len(rows)} session" + ("s" if len(rows) != 1 else ""),
    )
    rendered = [title]
    for entry in rows:
        captured = _time(entry.get("capturedAt"))
        summary = safe_text(entry.get("taskSummary"), "untitled session")
        capture = safe_text(entry.get("captureStatus"), "unavailable")
        rendered.extend(
            [
                "",
                style.wrap(pal, rst, "dim", captured) + "  " + summary,
                "  " + _knowledge(entry) + f" · capture {capture}",
                "  " + _eligibility(entry.get("eligibility")),
                "  " + _contribution(entry.get("contributionState")),
                *("  " + line for line in _skills(entry.get("distilledSkills"))),
            ]
        )
    return "\n".join(rendered)
