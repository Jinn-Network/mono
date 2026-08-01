"""Evidence-first auto-pickup — thin delegation to ``jinn-layer session
pickup`` (Stage 1 rescope R3, closes mono #1732).

At each new task/repository checkpoint the plugin sends the current raw
message (plus session metadata) to the core's evidence-first retrieval policy
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

import hashlib
import json
import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import corpus_view
from . import jinn_layer
from . import style
from .consent import get_hermes_home
from .harness import harness_name, harness_version

logger = logging.getLogger(__name__)

# The point-of-use corpus signal (design 1c / #1405 step 4; rescope §3.4).
# Emitted once per successful checkpoint, only when evidence was provided.
# Default sink mirrors _user_line in __init__.py: stderr, which
# prompt_toolkit proxies above the input area while the TUI runs — and,
# like that channel, strips ANSI unconditionally before printing (mono
# issue #1798): the proxy renders raw ESC bytes as noise rather than
# interpreting them. ``corpus_view.render_evidence_signal_line`` is the sole
# source of this line's format.
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


@dataclass(frozen=True)
class PickupOutcome:
    context: Optional[Dict[str, str]]
    delivered_canonical_episode_ids: tuple[str, ...] = ()


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
        sink(corpus_view.render_evidence_signal_line(searched_terms, provided_count))
    except Exception:
        logger.debug("jinn: corpus signal render failed", exc_info=True)


def _build_request(
    user_message: str,
    session_id: str,
    model: str,
    repository_slug: Optional[str],
    exclude_canonical_episode_ids: Optional[List[str]] = None,
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
        "excludeCanonicalEpisodeIds": [
            value
            for value in (exclude_canonical_episode_ids or [])
            if isinstance(value, str) and value
        ],
    }


def pickup(
    user_message: str,
    runner: Optional[jinn_layer.Runner] = None,
    signal_sink: Optional[SignalSink] = None,
    activity: Optional[Dict[str, Any]] = None,
    session_id: str = "",
    model: str = "",
    repository_slug: Optional[str] = None,
    session_kind: str = "user",
    parent_session_id: Optional[str] = None,
    exclude_canonical_episode_ids: Optional[List[str]] = None,
) -> Optional[Dict[str, str]]:
    """Evidence pickup. Returns ``{"context": ...}`` for the
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
    return pickup_with_outcome(
        user_message,
        runner=runner,
        signal_sink=signal_sink,
        activity=activity,
        session_id=session_id,
        model=model,
        repository_slug=repository_slug,
        session_kind=session_kind,
        parent_session_id=parent_session_id,
        exclude_canonical_episode_ids=exclude_canonical_episode_ids,
    ).context


def pickup_with_outcome(
    user_message: str,
    runner: Optional[jinn_layer.Runner] = None,
    signal_sink: Optional[SignalSink] = None,
    activity: Optional[Dict[str, Any]] = None,
    session_id: str = "",
    model: str = "",
    repository_slug: Optional[str] = None,
    session_kind: str = "user",
    parent_session_id: Optional[str] = None,
    exclude_canonical_episode_ids: Optional[List[str]] = None,
) -> PickupOutcome:
    """Run pickup while preserving canonical delivery metadata for the host."""
    try:
        return _pickup_inner(
            user_message,
            runner,
            signal_sink or _default_signal_sink,
            activity,
            session_id,
            model,
            repository_slug,
            session_kind,
            parent_session_id,
            exclude_canonical_episode_ids,
        )
    except Exception as exc:
        logger.warning("jinn: pickup failed open: %s", exc)
        return PickupOutcome(context=None)


def _pickup_inner(
    user_message: str,
    runner: Optional[jinn_layer.Runner],
    signal_sink: SignalSink,
    activity: Optional[Dict[str, Any]],
    session_id: str,
    model: str,
    repository_slug: Optional[str],
    session_kind: str,
    parent_session_id: Optional[str],
    exclude_canonical_episode_ids: Optional[List[str]],
) -> PickupOutcome:
    config = load_config()
    if not config.get("enabled", True):
        return PickupOutcome(context=None)

    if activity is not None:
        activity["retrievalFired"] = True
        activity["deliveryMode"] = "degraded"

    request = _build_request(
        user_message,
        session_id,
        model,
        repository_slug,
        exclude_canonical_episode_ids,
    )
    request["meta"]["kind"] = session_kind
    if parent_session_id:
        request["meta"]["parentSessionId"] = parent_session_id
    code, out, _err = jinn_layer.session_pickup(request, runner)
    if code != 0:
        return PickupOutcome(context=None)

    try:
        envelope = jinn_layer.parse_session_pickup_response(out)
    except ValueError:
        return PickupOutcome(context=None)
    if envelope.get("status") == "unavailable":
        return PickupOutcome(context=None)

    value = envelope.get("value")
    if not isinstance(value, dict):
        return PickupOutcome(context=None)
    # A v1 response without `packets` is treated as degraded-nothing: a stale
    # jinn-layer that predates this field would otherwise round-trip an old
    # `contextBlock` shape (skill suggestion/install text) through the new
    # rendering path unverified. Never reintroduce install hints (rescope R3 AC).
    if "packets" not in value:
        return PickupOutcome(context=None)

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
        activity["eligibleRefs"] = [
            ref for ref in (value.get("eligibleRefs") or [])
            if isinstance(ref, str) and ref
        ]

    context_block = value.get("contextBlock")
    if not isinstance(context_block, str) or not context_block.strip():
        if activity is not None:
            activity["providedRefs"] = []
            activity["deliveredRefs"] = []
            activity["deliveryMode"] = (
                "degraded"
                if envelope.get("status") == "degraded"
                or value.get("deliveryMode") == "degraded"
                else "withheld"
            )
            activity.pop("deliveredContentHash", None)
        return PickupOutcome(context=None)
    if activity is not None:
        activity["providedRefs"] = provided_refs
        activity["deliveredRefs"] = provided_refs
        activity["deliveryMode"] = (
            "degraded"
            if envelope.get("status") == "degraded"
            or value.get("deliveryMode") == "degraded"
            else "delivered"
        )
        activity["deliveredContentHash"] = (
            "sha256:" + hashlib.sha256(context_block.encode("utf-8")).hexdigest()
        )

    _emit_evidence_signal(signal_sink, searched_terms, len(provided_refs))
    raw_delivered_ids = value.get("deliveredCanonicalEpisodeIds")
    delivered_canonical_episode_ids = (
        tuple(
            episode_id
            for episode_id in raw_delivered_ids
            if isinstance(episode_id, str) and episode_id
        )
        if isinstance(raw_delivered_ids, list)
        else ()
    )
    return PickupOutcome(
        context={"context": context_block},
        delivered_canonical_episode_ids=delivered_canonical_episode_ids,
    )
