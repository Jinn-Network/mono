"""Evidence-first auto-pickup — thin delegation to ``jinn-layer session
pickup`` (Stage 1 rescope R3, closes mono #1732).

At the first turn the plugin sends the raw first message (plus session
metadata) to the core's evidence-first retrieval policy
(``docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md``
§3, implemented once in ``packages/plugin``) and renders whatever
``contextBlock`` comes back, verbatim, into the injected context. Term
derivation, corpus search, selection, and knowledge-packet projection all
live in the core now — this module owns none of it, and carries no skill
classification or auto-adopt logic (that entire rail was removed from
pickup by R1; skills are excluded from evidence selection outright, not
suggested or installed from here).

Consumption is never consent-gated. Consent gates contributing only.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import jinn_layer
from . import style
from .consent import get_hermes_home
from .harness import harness_name, harness_version

logger = logging.getLogger(__name__)

# The point-of-use corpus signal (design 1c / #1405 step 4; rescope §3.4).
# Emitted once per session, only when evidence was actually provided.
# Default sink mirrors _user_line in __init__.py: stderr, which
# prompt_toolkit proxies above the input area while the TUI runs — and,
# like that channel, strips ANSI unconditionally before printing (mono
# issue #1798): the proxy renders raw ESC bytes as noise rather than
# interpreting them. The onboarding CLI's own rendering of this same line
# (render_evidence_signal_line's step-3 preview) runs terminal-blocking
# outside the TUI and stays styled — only this funnel goes plain.
SignalSink = Callable[[str], None]


def _default_signal_sink(line: str) -> None:
    try:
        print(style.strip_ansi(line), file=sys.stderr, flush=True)
    except Exception:
        pass


# The one pickup setting still host-configurable. Auto-adopt, its tier
# threshold, and the candidate cap moved into the core's fixed evidence-first
# selection policy (rescope §3.3) and are no longer read from here — see
# `packages/plugin/src/schemas/pickup-config.ts`'s `@deprecated` fields.
DEFAULT_CONFIG: Dict[str, Any] = {"enabled": True}

# First-message length carried as the pickup request's placeholder
# `taskSummary` (the process contract requires a non-empty string; the real
# task summary isn't assembled until session end). Generous but bounded —
# never truncates a realistic message, never sends unbounded input.
_MAX_TASK_SUMMARY_CHARS = 2000


def config_path() -> Path:
    return get_hermes_home() / "jinn" / "pickup.json"


def load_config() -> Dict[str, Any]:
    """The one pickup setting the host still owns: ``enabled``."""
    path = config_path()
    if not path.exists():
        return dict(DEFAULT_CONFIG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        merged = dict(DEFAULT_CONFIG)
        if isinstance(data, dict) and "enabled" in data:
            merged["enabled"] = bool(data["enabled"])
        return merged
    except Exception:
        logger.warning("jinn: unreadable pickup config at %s — using defaults", path)
        return dict(DEFAULT_CONFIG)


def _emit_evidence_signal(sink: SignalSink, searched_terms: List[str], provided_count: int) -> None:
    """Render + emit one ``◇ corpus`` line (rescope §3.4). Never raises — a
    signal must not break a pickup that otherwise succeeded."""
    try:
        from . import onboarding  # local import: avoids a module cycle at import time
        sink(onboarding.render_evidence_signal_line(searched_terms, provided_count))
    except Exception:
        logger.debug("jinn: corpus signal render failed", exc_info=True)


def _build_request(
    user_message: str,
    session_id: str,
    model: str,
    repository_slug: Optional[str],
) -> Dict[str, Any]:
    meta: Dict[str, Any] = {
        "sessionId": session_id or "default",
        "taskSummary": (user_message or "(no message yet)")[:_MAX_TASK_SUMMARY_CHARS],
        "harness": {"name": harness_name(), "version": harness_version()},
        "model": model or "unknown",
        "tools": [],
    }
    if repository_slug:
        meta["repositorySlug"] = repository_slug
    return {
        "contractVersion": jinn_layer.CONTRACT_VERSION,
        "meta": meta,
        "firstMessage": user_message or "",
    }


def pickup(
    user_message: str,
    runner: Optional[jinn_layer.Runner] = None,
    signal_sink: Optional[SignalSink] = None,
    activity: Optional[Dict[str, List[str]]] = None,
    session_id: str = "",
    model: str = "",
    repository_slug: Optional[str] = None,
) -> Optional[Dict[str, str]]:
    """First-turn evidence pickup. Returns ``{"context": ...}`` for the
    pre_llm_call hook (rendered verbatim into the injected context; cache-safe,
    as today) or ``None`` when there is nothing worth injecting. Fails open:
    any error — missing binary, contract mismatch, timeout, malformed
    response — returns ``None`` and the task proceeds untouched.

    ``activity``, when given, is populated with ``searchedTerms``/
    ``providedRefs`` from the core's response (rescope §3.6) — the caller's
    per-session activity dict, mutated in place.

    ``signal_sink`` receives the one ``◇ corpus`` line emitted when evidence
    is provided (rescope §3.4). Defaults to stderr; tests pass a collector.
    """
    try:
        return _pickup_inner(
            user_message,
            runner,
            signal_sink or _default_signal_sink,
            activity,
            session_id,
            model,
            repository_slug,
        )
    except Exception as exc:
        logger.warning("jinn: pickup failed open: %s", exc)
        return None


def _pickup_inner(
    user_message: str,
    runner: Optional[jinn_layer.Runner],
    signal_sink: SignalSink,
    activity: Optional[Dict[str, List[str]]],
    session_id: str,
    model: str,
    repository_slug: Optional[str],
) -> Optional[Dict[str, str]]:
    config = load_config()
    if not config.get("enabled", True):
        return None

    request = _build_request(user_message, session_id, model, repository_slug)
    code, out, _err = jinn_layer.session_pickup(request, runner)
    if code != 0:
        return None

    try:
        envelope = jinn_layer.parse_session_pickup_response(out)
    except ValueError:
        return None
    if envelope.get("status") == "unavailable":
        return None

    value = envelope.get("value")
    if not isinstance(value, dict):
        return None
    # A v1 response without `packets` is treated as degraded-nothing: a stale
    # jinn-layer that predates this field would otherwise round-trip an old
    # `contextBlock` shape (skill suggestion/install text) through the new
    # rendering path unverified. Never reintroduce install hints (rescope R3 AC).
    if "packets" not in value:
        return None

    searched_terms = [
        term for term in (value.get("searchedTerms") or [])
        if isinstance(term, str) and term
    ]
    packets = value.get("packets")
    provided_refs: List[str] = []
    if isinstance(packets, list):
        for packet in packets:
            if isinstance(packet, dict) and isinstance(packet.get("ref"), str) and packet["ref"]:
                provided_refs.append(packet["ref"])

    if activity is not None:
        activity["searchedTerms"] = searched_terms
        activity["providedRefs"] = provided_refs

    context_block = value.get("contextBlock")
    if not isinstance(context_block, str) or not context_block.strip():
        return None

    _emit_evidence_signal(signal_sink, searched_terms, len(provided_refs))
    return {"context": context_block}
