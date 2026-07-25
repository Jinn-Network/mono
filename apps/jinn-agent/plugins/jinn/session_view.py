"""Pure Stage 1 current-session and completion renderers."""

from __future__ import annotations

import os
from typing import Any, Dict, Iterable, List

from . import style


def _verbose() -> bool:
    """Protocol detail (eligibility, distillation, contribution) for operators."""
    return (os.environ.get("JINN_VERBOSE") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


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


def _knowledge_line(provided_refs: List[str], nothing_found: bool) -> str:
    if nothing_found:
        return "No relevant prior notes found"
    count = len(provided_refs)
    noun = "note" if count == 1 else "notes"
    return f"Used {count} prior {noun} from your local Jinn history"


def _knowledge_lines_verbose(
    searched_terms: List[str], provided_refs: List[str], nothing_found: bool
) -> List[str]:
    if nothing_found:
        return ["knowledge searched · nothing relevant found"]
    terms = ", ".join(searched_terms) if searched_terms else "(none)"
    refs = ", ".join(provided_refs)
    return [f"knowledge searched {terms} · provided {len(provided_refs)} ({refs})"]


def _capture_line(capture_status: str) -> str:
    return {
        "captured": "Saved this session for next time",
        "captured-locally": "Saved this session locally",
        "unavailable": "Could not save this session",
    }.get(capture_status, "Could not save this session")


def _render(title: str, lines: Iterable[str]) -> str:
    pal, rst = style.palette()
    output = [style.wrap(pal, rst, "fg", title)]
    output.extend("  " + line for line in lines)
    return "\n".join(output)


def render_current(
    *, activity: Dict[str, Any], capture_active: bool
) -> str:
    """Render live state; default copy is operator-facing, not protocol jargon."""
    searched_terms = _terms(activity.get("searchedTerms"))
    provided_refs = _refs(activity.get("providedRefs"))
    nothing_found = not provided_refs and bool(searched_terms)
    if not searched_terms and not provided_refs:
        knowledge = ["No relevant prior notes yet"]
    elif _verbose():
        knowledge = _knowledge_lines_verbose(
            searched_terms, provided_refs, nothing_found=nothing_found
        )
    else:
        knowledge = [_knowledge_line(provided_refs, nothing_found=nothing_found)]
    lines = list(knowledge)
    if _verbose():
        lines.extend([
            "capture active" if capture_active else "capture waiting for ordinary work",
            "local learning reserves this capture at session end",
            "eligibility pending until session end",
            "contribution parked · nothing leaves this machine",
        ])
    return _render("Jinn", lines)


def _eligibility(value: object) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("eligible"), bool):
        return "eligibility unavailable"
    verdict = "eligible" if value["eligible"] else "not eligible"
    reason = _text(value.get("reason"), "")
    return f"eligibility {verdict}" + (f" — {reason}" if reason else "")


def _published_contribution_line(contribution: object) -> str | None:
    if not isinstance(contribution, dict):
        return None
    receipt = contribution.get("value")
    if not isinstance(receipt, dict):
        return None
    if _text(receipt.get("status"), "") != "published":
        return None
    return "jinn: contribution published — immutable"


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
    if _verbose():
        knowledge = _knowledge_lines_verbose(searched_terms, provided_refs, nothing_found)
    else:
        knowledge = [_knowledge_line(provided_refs, nothing_found)]
    lines = [*knowledge, _capture_line(capture_status)]
    published = _published_contribution_line(contribution)
    if published is not None:
        lines.append(published)
    if _verbose():
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
        lines.extend([capture, learning, _eligibility(core.get("eligibility")), contribution_line])
    return _render("Jinn", lines)
