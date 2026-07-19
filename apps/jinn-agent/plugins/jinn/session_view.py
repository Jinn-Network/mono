"""Pure Stage 1 current-session and completion renderers."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List

from . import style


def _text(value: object, fallback: str = "unavailable") -> str:
    if not isinstance(value, str) or not value.strip():
        return fallback
    return style.sanitise(value.strip())


def _terms(value: object) -> List[str]:
    if not isinstance(value, list):
        return []
    return [_text(term, "") for term in value if _text(term, "")]


def _refs(value: object) -> List[str]:
    """Accepts either `providedPackets` (`[{ref, title}, ...]`, the
    SessionSummary shape) or a bare ref list (the activity fallback)."""
    if not isinstance(value, list):
        return []
    refs: List[str] = []
    for item in value:
        ref = _text(item.get("ref"), "") if isinstance(item, dict) else _text(item, "")
        if ref:
            refs.append(ref)
    return refs


def _knowledge_lines(searched_terms: List[str], provided_refs: List[str], nothing_found: bool) -> List[str]:
    if nothing_found:
        return ["knowledge searched · nothing relevant found"]
    terms = ", ".join(searched_terms) if searched_terms else "(none)"
    refs = ", ".join(provided_refs)
    return [f"knowledge searched {terms} · provided {len(provided_refs)} ({refs})"]


def _render(title: str, lines: Iterable[str]) -> str:
    pal, rst = style.palette()
    output = [style.wrap(pal, rst, "fg", title)]
    output.extend("  " + line for line in lines)
    return "\n".join(output)


def render_current(
    *, activity: Dict[str, Any], capture_active: bool
) -> str:
    """Render live state only; eligibility/contribution are end-of-session facts."""
    searched_terms = _terms(activity.get("searchedTerms"))
    provided_refs = _refs(activity.get("providedRefs"))
    knowledge = (
        ["knowledge nothing relevant found yet"]
        if not searched_terms and not provided_refs
        else _knowledge_lines(searched_terms, provided_refs, nothing_found=not provided_refs)
    )
    return _render("Jinn session", [
        *knowledge,
        "capture active" if capture_active else "capture waiting for ordinary work",
        "local learning reserves this capture at session end",
        "eligibility pending until session end",
        "contribution parked · nothing leaves this machine",
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
        line = "jinn: contribution published — immutable"
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
    """Render one complete outcome from core facts plus host-local capture state.

    ``summary`` is the core's `SessionSummary` (searchedTerms/providedPackets/
    nothingFound) when the process bridge produced one; ``activity`` is the
    host-local fallback (searchedTerms/providedRefs) used when it did not
    (rescope §3.6).
    """
    core = summary if isinstance(summary, dict) else {}
    searched_terms = _terms(core.get("searchedTerms")) or _terms(activity.get("searchedTerms"))
    provided_refs = _refs(core.get("providedPackets")) or _refs(activity.get("providedRefs"))
    stated_nothing_found = core.get("nothingFound")
    nothing_found = (
        stated_nothing_found
        if isinstance(stated_nothing_found, bool)
        else not bool(provided_refs)
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
        *_knowledge_lines(searched_terms, provided_refs, nothing_found),
        capture,
        learning,
        _eligibility(core.get("eligibility")),
        contribution_line,
    ])
