"""Pure Stage 1 current-session and completion renderers."""

from __future__ import annotations

from typing import Any, Dict, Iterable

from . import style


def _text(value: object, fallback: str = "unavailable") -> str:
    if not isinstance(value, str) or not value.strip():
        return fallback
    return style.sanitise(value.strip())


def _refs(activity: Dict[str, Any], field: str) -> list[str]:
    value = activity.get(field)
    if not isinstance(value, list):
        return []
    return [_text(ref, "") for ref in value if _text(ref, "")]


def _knowledge_lines(activity: Dict[str, Any], nothing_found: bool) -> list[str]:
    surfaced = _refs(activity, "surfacedRefs")
    fetched = _refs(activity, "fetchedRefs")
    installed = _refs(activity, "installedSkillRefs")
    if nothing_found:
        return ["knowledge nothing relevant found"]
    lines = [
        f"knowledge {len(surfaced)} surfaced · {len(fetched)} fetched · "
        f"{len(installed)} installed"
    ]
    if surfaced:
        lines.append("surfaced " + ", ".join(surfaced))
    used = list(dict.fromkeys([*fetched, *installed]))
    if used:
        lines.append("used " + ", ".join(used))
    return lines


def _render(title: str, lines: Iterable[str]) -> str:
    pal, rst = style.palette()
    output = [style.wrap(pal, rst, "fg", title)]
    output.extend("  " + line for line in lines)
    return "\n".join(output)


def render_current(
    *, activity: Dict[str, Any], capture_active: bool, share_enabled: bool
) -> str:
    """Render live state only; eligibility/contribution are end-of-session facts."""
    nothing_yet = not any(
        _refs(activity, field)
        for field in ("surfacedRefs", "fetchedRefs", "installedSkillRefs")
    )
    knowledge = (
        ["knowledge nothing relevant found yet"]
        if nothing_yet
        else _knowledge_lines(activity, False)
    )
    return _render("Jinn session", [
        *knowledge,
        "capture active" if capture_active else "capture waiting for ordinary work",
        "local learning reserves this capture at session end",
        "eligibility pending until session end",
        "contribution pending until session end · publication "
        + ("ON" if share_enabled else "OFF"),
    ])


def _eligibility(value: object) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("eligible"), bool):
        return "eligibility unavailable"
    verdict = "eligible" if value["eligible"] else "not eligible"
    reason = _text(value.get("reason"), "")
    return f"eligibility {verdict}" + (f" — {reason}" if reason else "")


def _contribution(value: object) -> str:
    if value is None or not isinstance(value, dict):
        return "contribution unavailable"
    port_status = value.get("status")
    if port_status == "unavailable":
        reason = _text(value.get("reason"), "")
        return "contribution unavailable" + (f" — {reason}" if reason else "")
    receipt = value.get("value")
    if not isinstance(receipt, dict):
        return "contribution unavailable"
    status = _text(receipt.get("status"), "unavailable")
    line = f"contribution {status}"
    if status == "published":
        line = "jinn: contribution published — immutable (/jinn ledger for the anchor)"
    return line


def render_complete(
    *,
    summary: object,
    activity: Dict[str, Any],
    capture_status: str,
    local_learning_status: str,
    contribution: object,
    candidate_created: bool = True,
) -> str:
    """Render one complete outcome from core facts plus host-local capture state."""
    core = summary if isinstance(summary, dict) else {}
    summary_activity = {
        "surfacedRefs": core.get("surfacedRefs", activity.get("surfacedRefs", [])),
        "fetchedRefs": core.get("fetchedRefs", activity.get("fetchedRefs", [])),
        "installedSkillRefs": core.get(
            "installedSkillRefs", activity.get("installedSkillRefs", [])
        ),
    }
    stated_nothing_found = core.get("nothingFound")
    nothing_found = (
        stated_nothing_found
        if isinstance(stated_nothing_found, bool)
        else not any(
            _refs(summary_activity, field)
            for field in ("surfacedRefs", "fetchedRefs", "installedSkillRefs")
        )
    )
    learning = {
        "pending": "local learning pending — capture reserved for distillation",
        "off": "local learning off",
        "unavailable": "local learning unavailable — capture was not reserved",
    }.get(local_learning_status, "local learning unavailable")
    capture = {
        "captured": "episode captured",
        "captured-locally": "episode captured locally — process bridge degraded",
        "unavailable": "episode capture unavailable",
    }.get(capture_status, "episode capture unavailable")
    contribution_line = (
        _contribution(contribution)
        if candidate_created
        else "contribution no reusable public-task candidate"
    )
    return _render("Jinn session complete", [
        *_knowledge_lines(summary_activity, nothing_found),
        capture,
        learning,
        _eligibility(core.get("eligibility")),
        contribution_line,
    ])
