"""Payload-agnostic auto-pickup — the corpus's receiving end (mono #1345).

At task start the harness works out what kind of task this is, looks up the
corpus for matching payloads, and decides per candidate:

  - **adopt automatically** when the payload's verifiability tier meets the
    configured threshold (default: ``evaluator-verified``) AND an adopter
    exists for its payload type. Verification under bond is the trust gate —
    not a human keystroke. Today's corpus has nothing verified, so today this
    path is dormant by honest default.
  - **suggest** otherwise: the candidate is surfaced to the agent as injected
    context (cache-safe: Hermes injects plugin context into the user message,
    never the system prompt), and installing stays a deliberate act.

Payload-agnostic: adopters are a registry keyed by payload type. v0 ships
one adopter (``skill`` → install into Hermes's native skills dir). Richer
payloads — loadout recommendations (model/toolset per distribution), full
optimised loadouts — plug in as new adopters without touching the pickup
flow: same rail, richer payloads.

Consumption is never consent-gated. Consent gates contributing only.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import jinn_layer
from . import onboarding
from . import skills_install
from .consent import get_hermes_home

logger = logging.getLogger(__name__)

# The point-of-use corpus signal (design 1c / #1405 step 4). Emitted once per
# adopted contribution — the harness is actually *using* another operator's
# work in this run, so the operator sees a checkable line at that moment. A
# suggested-but-not-adopted candidate is only injected context (not used), so
# it never emits a signal. Default sink mirrors _user_line in __init__.py:
# stderr, which prompt_toolkit proxies above the input area while the TUI runs.
SignalSink = Callable[[str], None]


def _default_signal_sink(line: str) -> None:
    try:
        print(line, file=sys.stderr, flush=True)
    except Exception:
        pass


def _emit_corpus_signal(sink: SignalSink, skill: str, provenance: str, env_ref: str) -> None:
    """Render + emit one ``◇ corpus`` line. Never raises — a signal must not
    break a pickup that otherwise succeeded."""
    try:
        sink(onboarding.render_corpus_signal_line(skill, provenance, env_ref))
    except Exception:
        logger.debug("jinn: corpus signal render failed", exc_info=True)


def _short_ref(ref: str) -> str:
    """Abbreviate a long content ref for the signal line's envelope column."""
    r = str(ref or "")
    if len(r) <= 12:
        return r
    return f"{r[:5]}…{r[-4:]}"

# Weakest → strongest; mirrors VERIFIABILITY_TIERS in the frozen envelope schema.
TIER_ORDER = ["user-accepted", "tests-passed", "evaluator-verified"]

DEFAULT_CONFIG: Dict[str, Any] = {
    "enabled": True,
    # The tier at (or above) which a payload is adopted without asking.
    "autoAdoptTier": "evaluator-verified",
    "maxCandidates": 3,
}

# Pickup runs on the first turn, before the LLM call — keep it snappy and
# fail-open. A broken jinn-layer must cost seconds, not the session.
_PICKUP_TIMEOUT_S = 15

_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "for", "with", "into", "onto",
    "this", "that", "these", "those", "from", "then", "than", "when",
    "what", "which", "where", "how", "why", "can", "could", "should",
    "would", "will", "just", "please", "help", "need", "want", "make",
    "using", "about", "have", "has", "had", "you", "your", "our", "not",
}


def config_path() -> Path:
    return get_hermes_home() / "jinn" / "pickup.json"


def load_config() -> Dict[str, Any]:
    path = config_path()
    if not path.exists():
        return dict(DEFAULT_CONFIG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        merged = dict(DEFAULT_CONFIG)
        if isinstance(data, dict):
            merged.update(data)
        if merged.get("autoAdoptTier") not in TIER_ORDER:
            merged["autoAdoptTier"] = DEFAULT_CONFIG["autoAdoptTier"]
        return merged
    except Exception:
        logger.warning("jinn: unreadable pickup config at %s — using defaults", path)
        return dict(DEFAULT_CONFIG)


def tier_at_least(tier: str, threshold: str) -> bool:
    try:
        return TIER_ORDER.index(tier) >= TIER_ORDER.index(threshold)
    except ValueError:
        return False  # unknown tier never auto-adopts


def _pickup_runner(argv: List[str]) -> Tuple[int, str]:
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=_PICKUP_TIMEOUT_S, check=False,
        )
        return proc.returncode, proc.stdout.strip()
    except Exception as exc:  # timeout, missing binary — pickup fails open
        return 1, str(exc)


def derive_terms(user_message: str, max_terms: int = 2) -> List[str]:
    """Naive v0 distribution guess: distinctive words from the first line.

    The corpus content search is a substring match over tags + summaries, so
    single tokens are the useful query shape. Replaceable by real distribution
    classification (tags from a local model, embedding lookup) without
    touching the pickup flow.
    """
    first_line = (user_message or "").strip().splitlines()[0] if user_message else ""
    terms: List[str] = []
    for raw in first_line.lower().split():
        word = "".join(c for c in raw if c.isalnum() or c in "-_")
        if len(word) >= 4 and word not in _STOPWORDS and word not in terms:
            terms.append(word)
        if len(terms) >= max_terms:
            break
    return terms


# ── Payload classification + adopters ────────────────────────────────────────

def classify_payload(trace: Dict[str, Any]) -> str:
    """Payload type of a corpus trace. v0 knows 'skill'; everything else is
    'unknown' and is never adopted (only mentioned)."""
    steps = trace.get("steps")
    if isinstance(steps, list):
        for step in steps:
            attrs = step.get("attributes") if isinstance(step, dict) else None
            if isinstance(attrs, dict) and isinstance(attrs.get("skill.md"), str):
                return "skill"
    return "unknown"


def _adopt_skill(ref: str, runner: Optional[jinn_layer.Runner]) -> str:
    path = skills_install.install(ref, runner=runner)
    return f"installed skill at {path}"


# Payload type → adopter(ref, runner) -> human-readable receipt.
# New payload types (loadout recommendations, full loadouts) register here.
PAYLOAD_ADOPTERS: Dict[str, Callable[[str, Optional[jinn_layer.Runner]], str]] = {
    "skill": _adopt_skill,
}


# ── The pickup ───────────────────────────────────────────────────────────────

def pickup(
    user_message: str,
    runner: Optional[jinn_layer.Runner] = None,
    signal_sink: Optional[SignalSink] = None,
) -> Optional[Dict[str, str]]:
    """First-turn corpus lookup. Returns ``{"context": ...}`` for the
    pre_llm_call hook (or None when there is nothing worth saying).
    Fails open: any error returns None and the task proceeds untouched.

    ``signal_sink`` receives one ``◇ corpus`` line per adopted contribution
    (design 1c). Defaults to stderr; tests pass a collector.
    """
    try:
        return _pickup_inner(user_message, runner or _pickup_runner, signal_sink or _default_signal_sink)
    except Exception as exc:
        logger.warning("jinn: pickup failed open: %s", exc)
        return None


def _pickup_inner(
    user_message: str,
    runner: jinn_layer.Runner,
    signal_sink: SignalSink,
) -> Optional[Dict[str, str]]:
    config = load_config()
    if not config.get("enabled", True):
        return None
    terms = derive_terms(user_message)
    if not terms:
        return None

    # Search per term; dedupe by ref.
    candidates: Dict[str, Dict[str, Any]] = {}
    for term in terms:
        code, out = jinn_layer.run(["corpus", "search", term, "--json", "--limit", "3"], runner)
        if code != 0:
            continue
        try:
            hits = json.loads(out)
        except json.JSONDecodeError:
            continue
        if not isinstance(hits, list):
            continue
        for hit in hits:
            if isinstance(hit, dict) and isinstance(hit.get("ref"), str):
                candidates.setdefault(hit["ref"], hit)
    if not candidates:
        return None

    installed = {row["slug"] for row in skills_install.list_installed()}
    threshold = str(config["autoAdoptTier"])
    adopted: List[str] = []
    suggested: List[str] = []

    for ref in list(candidates)[: int(config["maxCandidates"])]:
        code, out = jinn_layer.run(["corpus", "get", ref, "--json"], runner)
        if code != 0:
            continue
        try:
            record = json.loads(out)
            trace, _sha = skills_install._extract_trace(record)
        except Exception:
            continue

        payload_type = classify_payload(trace)
        tier = str(((trace.get("outcome") or {}).get("verifiabilityTier")) or "")
        summary = str(((trace.get("task") or {}).get("summary")) or ref)[:120]

        if payload_type == "skill":
            try:
                _md, slug = skills_install._skill_md_and_slug(trace, ref)
            except Exception:
                continue
            if slug in installed:
                continue
            if tier_at_least(tier, threshold):
                try:
                    receipt = PAYLOAD_ADOPTERS[payload_type](ref, runner)
                    adopted.append(f"- {slug} ({tier}): {receipt}")
                    # Point-of-use signal: the harness is now using this
                    # operator-contributed skill in the run. One line, checkable.
                    _emit_corpus_signal(
                        signal_sink, slug, f"{tier} · {summary}", _short_ref(ref)
                    )
                except Exception as exc:
                    logger.warning("jinn: auto-adopt of %s failed: %s", ref, exc)
                continue
            suggested.append(
                f"- {slug} (tier: {tier}) — {summary}\n  ref: {ref} · install: /jinn skills install {ref}"
            )
        else:
            # Unknown payload types are never adopted; mention verified ones only.
            if tier_at_least(tier, threshold):
                suggested.append(f"- ({payload_type}, {tier}) {summary} — ref: {ref}")

    if not adopted and not suggested:
        return None

    lines = ["[jinn corpus] Relevant to this task:"]
    if adopted:
        lines.append("Adopted automatically (verified):")
        lines.extend(adopted)
    if suggested:
        lines.append("Available in the corpus (unverified — read with the corpus tools, or the user can install):")
        lines.extend(suggested)
    return {"context": "\n".join(lines)}
