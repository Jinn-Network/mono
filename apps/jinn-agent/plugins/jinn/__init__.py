"""jinn plugin — the Jinn-Hermes fork's single integration surface.

The plugin captures local session evidence unconditionally, assembles one
complete EpisodeV1, and delegates it through the versioned ``jinn-layer
session end`` process bridge.  The core owns canonical persistence,
eligibility, contribution recording/veto, and summaries.  A bridge failure
falls back to one local EpisodeV1 write; the retired raw pending/publication
queue is never created or drained here.

Outbound contribution is parked for Stage 2. Retained Stage 1 consent state
is ignored; local capture, candidate recording, mining, and distillation stay
live. ``/jinn`` exposes status, session, history, veto, distill, and corpus
consumption.

Upstream-merge procedure: see JINN.md at the repo root.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shlex
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Set
from tools.skill_provenance import is_background_review

from . import capture_buffer as buf
from . import consent
from . import distill
from . import doctor
from . import history_view
from . import jinn_layer
from . import pickup
from . import session_bridge
from . import session_view
from . import skills_install
from . import style

logger = logging.getLogger(__name__)

_veto_lock = threading.Lock()
_vetoed_tasks: Set[str] = set()

# Distilled-skill use counts at session start; the session-end payoff surface
# reports only skills used during this session.
_distill_usage_snapshot: Dict[str, int] = {}

# Test seam: overridable subprocess runner (None = real jinn-layer binary).
_runner: Optional[jinn_layer.Runner] = None

# Per-session v1 handshake, re-checked by the doctor fast path at every
# session start (mono #1817 — no process-lifetime memoization). A reason here
# disables only the additive session-end process bridge; Python pickup,
# capture, fallback persistence, and distillation remain live.
_contract_lock = threading.Lock()
_degraded: Optional[str] = None

# Per-session repo/activity evidence. Populated at session start and consumed
# once at session end.
_session_state_lock = threading.Lock()
_session_states: Dict[str, Dict[str, Any]] = {}
_internal_session_lock = threading.Lock()
_internal_sessions: Dict[tuple[str, int], str] = {}


def _park_contribution_publication() -> None:
    """Quarantine retained Stage 1 authorization at the shared store boundary.

    The direct marker is the fail-closed host fallback. The layer command also
    rewrites already-previewed or queued records to ``disabled`` under the
    store's publication lock. Both operations are idempotent; neither affects
    local evidence, candidate recording, or mining.
    """
    session_bridge.set_publication_enabled(False)
    try:
        jinn_layer.run(
            ["contribution", "disable", "--json"],
            runner=_runner,
            timeout_s=10,
        )
    except Exception:
        pass


def _reset_session_state() -> None:
    with _session_state_lock:
        _session_states.clear()
    with _internal_session_lock:
        _internal_sessions.clear()


def _user_line(msg: str) -> None:
    """One user-visible session-end line (mono issue #1385).

    ``logger.info`` lands in the log file only — terminal-silent in both
    the TUI and ``-q`` modes, so operators got zero per-task feedback that
    a trace was held or published. ``print(..., file=sys.stderr)`` is the
    fork-adjacent precedent for operator-visible plugin output (see
    plugins/memory/hindsight, issue #13125): while the TUI runs,
    prompt_toolkit's ``patch_stdout`` proxies stderr and renders the line
    above the input area (the app is ``full_screen=False``); at shutdown
    and in ``-q`` mode it is plain stderr. Never raise from here — a
    feedback line must not break a session end.

    Strips ANSI unconditionally before printing (mono issue #1798): the
    ``patch_stdout`` proxy renders raw ESC bytes as ``?[38;2;…m`` noise
    rather than interpreting them, so this channel emits plain text always,
    regardless of ``COLORTERM``/``NO_COLOR``. The fork-precedent plugins this
    channel was modeled on (memory/hindsight) print plain text too — the
    styling here was our deviation. Styled surfaces that never run inside
    the TUI are unaffected.
    """
    try:
        print(style.strip_ansi(msg), file=sys.stderr, flush=True)
    except Exception:
        pass


def _veto_path(session_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in session_id)[:96]
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:12]
    name = f"{safe or 'session'}-{digest}.json"
    return consent.get_hermes_home() / "jinn" / "vetoes" / name


def _record_veto(session_id: str) -> None:
    marker = _veto_path(session_id)
    marker.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(marker.parent, 0o700)
    payload = json.dumps({"sessionId": session_id, "status": "vetoed"}, indent=2) + "\n"
    try:
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if marker.is_symlink() or not marker.is_file():
            raise OSError(f"unsafe veto marker: {marker}")
        os.chmod(marker, 0o600)
    else:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(marker, 0o600)
    with _veto_lock:
        _vetoed_tasks.add(session_id)


def _session_vetoed(session_id: str) -> bool:
    with _veto_lock:
        if session_id in _vetoed_tasks:
            return True
    return _veto_path(session_id).is_file()


def _clear_veto(session_id: str) -> None:
    try:
        _veto_path(session_id).unlink(missing_ok=True)
    except OSError:
        return
    with _veto_lock:
        _vetoed_tasks.discard(session_id)


def _empty_activity() -> Dict[str, Any]:
    """Evidence-first pickup facts (searchedTerms/providedRefs, rescope §3.6)
    plus the internal fetch-attempt detail the corpus_search/corpus_fetch
    agent tools still record (surfacedRefs/fetchedRefs). installedSkillRefs
    is gone with the skill adopt/install path pickup no longer has."""
    return {
        "retrievalFired": False,
        "eligibleRefs": [],
        "deliveredRefs": [],
        "deliveryMode": "disabled",
        "searchedTerms": [],
        "providedRefs": [],
        "surfacedRefs": [],
        "fetchedRefs": [],
        "installedSkillRefs": [],
    }


def _session_identity(session_id: str) -> tuple[str, str, Optional[str]]:
    """Separate host-internal review evidence from its foreground parent."""
    parent = session_id or "default"
    if not is_background_review():
        return parent, "user", None
    thread_id = threading.get_ident()
    key = (parent, thread_id)
    with _internal_session_lock:
        logical = _internal_sessions.get(key)
        if logical is None:
            suffix = hashlib.sha256(
                f"{parent}:{thread_id}:{time.time_ns()}".encode("utf-8")
            ).hexdigest()[:16]
            logical = f"{parent[:96]}-host-internal-{suffix}"[:128]
            _internal_sessions[key] = logical
    return logical, "host-internal", parent[:128]


def _release_internal_session(parent_session_id: Optional[str]) -> None:
    if parent_session_id is None:
        return
    with _internal_session_lock:
        _internal_sessions.pop((parent_session_id, threading.get_ident()), None)


def _state_for(session_id: str, cwd: Optional[Path] = None) -> Dict[str, Any]:
    key = session_id or "default"
    with _session_state_lock:
        state = _session_states.get(key)
        if state is None:
            state = {
                "snapshot": session_bridge.snapshot_repository(key, cwd=cwd),
                "activity": _empty_activity(),
                "intermediateFailureDiffs": [],
            }
            _session_states[key] = state
        return state


def _pop_state(session_id: str) -> Dict[str, Any]:
    key = session_id or "default"
    with _session_state_lock:
        return _session_states.pop(
            key,
            {
                "snapshot": None,
                "activity": _empty_activity(),
                "intermediateFailureDiffs": [],
            },
        )


def _peek_state(session_id: str) -> Dict[str, Any]:
    key = session_id or "default"
    with _session_state_lock:
        state = _session_states.get(key)
        if state is None:
            return {"activity": _empty_activity()}
        activity = dict(state.get("activity") or {})
        for field in (
            "eligibleRefs",
            "deliveredRefs",
            "searchedTerms",
            "providedRefs",
            "surfacedRefs",
            "fetchedRefs",
            "installedSkillRefs",
        ):
            activity[field] = list(activity.get(field) or [])
        return {
            **state,
            "activity": activity,
        }


def _record_activity(session_id: str, field: str, refs: list[str]) -> None:
    """Record only refs a successful host action actually observed.

    Internal fetch-attempt detail only (surfacedRefs/fetchedRefs, from the
    corpus_search/corpus_fetch agent tools) — searchedTerms/providedRefs are
    set wholesale by pickup.pickup()'s own response, not appended here.
    """
    if not session_id or field not in ("surfacedRefs", "fetchedRefs"):
        return
    state = _state_for(session_id)
    with _session_state_lock:
        seen = state["activity"][field]
        for ref in refs:
            if ref and ref not in seen:
                seen.append(ref)


# ── Hooks ────────────────────────────────────────────────────────────────────

def _on_session_start(session_id: str = "", platform: str = "", **_: Any) -> None:
    global _degraded
    _park_contribution_publication()
    cwd = _.get("cwd") or _.get("working_directory")
    _state_for(session_id, Path(cwd) if isinstance(cwd, str) and cwd else None)
    # Doctor fast path (mono #1817): re-check per session start — no
    # process-lifetime memoization. Loud on failure, silent when healthy.
    # Checks run outside the lock (they spawn subprocesses; the layer probe
    # alone is bounded at 10s) — the lock guards only the _degraded write,
    # matching the /jinn doctor branch.
    checks = doctor.run_checks(full=False, runner=_runner)
    with _contract_lock:
        _degraded = doctor.degraded_reason(checks)
    if not doctor._first_session_done():
        # First session ever: the banner is the whole verdict (spec §3.2 —
        # all green, or the first failure with its fix). No separate fail
        # loop, or the first failure would print twice.
        for line in doctor.first_session_banner(checks):
            _user_line(line)
        doctor._mark_first_session_done()
    else:
        for check in checks:
            if not check["ok"]:
                for line in doctor.fail_lines(check):
                    _user_line(line)
    # Pick up a background distillation left over from a previous process:
    # live pid → resume the ambient tail; dead without a run_end → one
    # recovery line + archive (mono #1539). Never blocks, never raises.
    try:
        distill.reattach_watcher(sink=_user_line)
    except Exception:
        pass
    global _distill_usage_snapshot
    _distill_usage_snapshot = distill.snapshot_usage()


def _on_pre_llm_call(
    session_id: str = "",
    user_message: str = "",
    is_first_turn: bool = False,
    model: str = "",
    platform: str = "",
    task_id: str = "",
    **_: Any,
) -> Optional[Dict[str, str]]:
    logical_session_id, session_kind, parent_session_id = _session_identity(session_id)
    # Local capture — UNCONDITIONAL (mono#1714): filling the buffer never
    # leaves the machine; local retention, mining, and distillation happen by
    # default. Not gated on is_first_turn: the buffer is keyed per session and
    # record_first_turn is setdefault-idempotent, so calling it every turn
    # recovers the summary/model even when the first-turn signal is unreliable
    # on some provider paths (mono #1404). Only the share step (a task leaving
    # the machine) is gated — see _on_session_end.
    buf.record_first_turn(task_id, logical_session_id, user_message, model, platform)
    # Ordered user-turn span for the EpisodeV1 trajectory (mono #1662).
    # record_first_turn stores metadata only; this appends the turn span so it
    # precedes this turn's tool calls (post_tool_call) and the assistant turn
    # (post_llm_call). Local capture, so unconditional per mono#1714.
    buf.record_user_turn(task_id, logical_session_id, user_message)
    # Consumption side — NEVER consent-gated: evidence-first corpus pickup.
    # Returns {"context": ...} (injected into the user message, cache-safe)
    # or None. Fails open inside pickup().
    if is_first_turn:
        state = _state_for(logical_session_id)
        snapshot = state.get("snapshot")
        repository_slug = snapshot.repository_slug if snapshot is not None else None
        return pickup.pickup(
            user_message,
            runner=_runner,
            activity=state["activity"],
            session_id=logical_session_id,
            model=model,
            repository_slug=repository_slug,
            session_kind=session_kind,
            parent_session_id=parent_session_id,
        )
    return None


def _on_post_tool_call(
    tool_name: str = "",
    args: Any = None,
    session_id: str = "",
    task_id: str = "",
    tool_call_id: str = "",
    result: Any = None,
    duration_ms: Optional[int] = None,
    **_: Any,
) -> None:
    logical_session_id, _, _ = _session_identity(session_id)
    # Local capture — UNCONDITIONAL (mono#1714): recording tool calls never
    # leaves the machine.
    buf.record_tool_call(
        task_id, logical_session_id, tool_name, tool_call_id, args, result, duration_ms
    )
    state = _state_for(logical_session_id)
    run = session_bridge.test_run_from_tool_call(
        tool_name, args, result, str(time.time_ns())
    )
    if run is not None and run["exitCode"] != 0 and state["snapshot"] is not None:
        try:
            failed_diff = session_bridge.accepted_diff(state["snapshot"])
        except Exception:
            failed_diff = ""
        if failed_diff and failed_diff not in state["intermediateFailureDiffs"]:
            state["intermediateFailureDiffs"].append(failed_diff)


def _on_post_llm_call(
    session_id: str = "",
    task_id: str = "",
    user_message: str = "",
    assistant_response: str = "",
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    **_: Any,
) -> None:
    logical_session_id, _, _ = _session_identity(session_id)
    # Complete the EpisodeV1 turn (mono #1662): the assistant span lands AFTER
    # this turn's tool calls (post_tool_call fires inside the tool loop, which
    # completes before post_llm_call). Local capture is UNCONDITIONAL (mono#1714)
    # — the buffer never leaves the machine; only the share step is gated.
    buf.record_assistant_turn(task_id, logical_session_id, assistant_response)
    # Record tokens only when the host reports meaningful usage. Zero/zero (the
    # getattr default when the agent has no usage) is treated as "no usage" so
    # cost.tokens is OMITTED rather than emitted as {0,0} (AC2, mono #1662).
    if input_tokens or output_tokens:
        buf.record_tokens(task_id, logical_session_id, input_tokens or 0, output_tokens or 0)


def _normalized_activity(activity: Dict[str, Any]) -> Dict[str, Any]:
    normalized = {
        "retrievalFired": bool(activity.get("retrievalFired")),
        "eligibleRefs": list(activity.get("eligibleRefs") or []),
        "deliveredRefs": list(activity.get("deliveredRefs") or []),
        "deliveryMode": activity.get("deliveryMode") or "disabled",
        "searchedTerms": list(activity.get("searchedTerms") or []),
        "providedRefs": list(activity.get("providedRefs") or []),
        "surfacedRefs": list(activity.get("surfacedRefs") or []),
        "fetchedRefs": list(activity.get("fetchedRefs") or []),
        "installedSkillRefs": list(activity.get("installedSkillRefs") or []),
    }
    delivered_hash = activity.get("deliveredContentHash")
    if isinstance(delivered_hash, str) and delivered_hash:
        normalized["deliveredContentHash"] = delivered_hash
    return normalized


def _delegate_session_end(
    episode: Dict[str, Any],
    *,
    activity: Dict[str, Any],
    eligibility_inputs: Dict[str, Any],
    contribution_candidate: Optional[Dict[str, Any]],
    contribution_vetoed: bool,
) -> Optional[Dict[str, Any]]:
    """Return the core result only when it canonically persisted this episode."""
    if _degraded is not None:
        return None
    normalized_activity = _normalized_activity(activity)
    request: Dict[str, Any] = {
        "contractVersion": jinn_layer.CONTRACT_VERSION,
        "episode": episode,
        "activity": normalized_activity,
        "eligibilityInputs": dict(eligibility_inputs),
        "contributionVetoed": bool(contribution_vetoed),
    }
    if contribution_candidate is not None:
        request["contributionCandidate"] = contribution_candidate
    try:
        code, out, _err = jinn_layer.session_end(request, runner=_runner)
        if code != 0:
            return None
        envelope = jinn_layer.parse_session_end_response(out)
        if envelope["status"] == "unavailable":
            return None
        value = envelope.get("value")
        if not isinstance(value, dict):
            return None
        persistence = value.get("persistence")
        if not isinstance(persistence, dict) or persistence.get("status") not in ("ok", "degraded"):
            return None
        persisted_value = persistence.get("value")
        persisted_id = persisted_value.get("episodeId") if isinstance(persisted_value, dict) else None
        if persisted_id != episode.get("episodeId"):
            return None
        return value
    except Exception:
        return None


def _episode_test_runs(episode: Dict[str, Any]) -> list[Dict[str, Any]]:
    runs = []
    for span in episode.get("trajectory", []):
        if not isinstance(span, dict) or span.get("kind") != "jinn.tool_call":
            continue
        attrs = span.get("attributes") if isinstance(span.get("attributes"), dict) else {}
        name = str(span.get("name") or "")
        tool_name = name.split(":", 1)[1] if name.startswith("tool:") else name
        run = session_bridge.test_run_from_tool_call(
            tool_name,
            attrs.get("tool.args"),
            attrs.get("tool.result"),
            str(span.get("endTimeUnixNano") or ""),
        )
        if run is not None:
            runs.append(run)
    return runs


def _on_session_end(
    session_id: str = "",
    task_id: str = "",
    completed: bool = False,
    interrupted: bool = False,
    skills_loadout: Optional[list] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    **_: Any,
) -> None:
    logical_session_id, session_kind, parent_session_id = _session_identity(session_id)
    _release_internal_session(parent_session_id)
    # Usage is native local telemetry, so show payoff independently of sharing
    # consent and before any capture-path early return.
    try:
        for line in distill.payoff_lines(_distill_usage_snapshot):
            _user_line(line)
    except Exception:
        pass

    # Local capture is unconditional. Stage 2 keeps the contribution substrate
    # local-only even when a Stage 1 consent file still says shareConsent=true.
    publish_enabled = False
    # Record the skills loadout + token fallback (host forward, mono #1662) —
    # local writes, so unconditional per mono#1714, before the popping assembly.
    buf.record_environment(task_id, logical_session_id, skills_loadout or [])
    # See _on_post_llm_call — zero/no usage omits cost.tokens (AC2, mono #1662).
    if input_tokens or output_tokens:
        buf.record_tokens(task_id, logical_session_id, input_tokens or 0, output_tokens or 0)

    # Pop the buffer ONCE for both shapes (assemble pops — see assemble_both).
    # Stage 2 never prepares a network-facing shape. The same episode remains
    # the local learning source and contribution-candidate raw material.
    task, episode = buf.assemble_both(
        task_id, logical_session_id, completed, interrupted, publish_consented=publish_enabled
    )

    if episode is None:
        state = _pop_state(logical_session_id)
        _user_line(session_view.render_complete(
            summary=None,
            activity=state.get("activity") or {},
            capture_status="unavailable",
            local_learning_status="unavailable",
            contribution=None,
            candidate_created=False,
        ))
        return

    # Tee for local distillation (mono #1537) — BEFORE the veto/publish
    # branching, so held, vetoed and published tasks all reserve a local
    # capture (a veto withholds from the NETWORK; local distillation never
    # leaves this machine). Distinct dir + lifecycle from the pending file:
    # the publish drain unlinks pending files, never captures.
    tee_path = (
        distill.tee_capture(task, session_id or task_id, runner=_runner)
        if task is not None
        else None
    )

    state = _pop_state(logical_session_id)
    snapshot = state.get("snapshot")
    try:
        accepted = session_bridge.accepted_diff(snapshot) if snapshot is not None else ""
    except Exception:
        accepted = ""
    episode["session"]["kind"] = session_kind
    if parent_session_id:
        episode["session"]["parentSessionId"] = parent_session_id
    snapshot_repository = (
        snapshot.repository_slug if snapshot is not None else None
    )
    if snapshot_repository:
        episode["task"]["repositorySlug"] = snapshot_repository
        episode["task"]["baseCommit"] = snapshot.base_head
    test_runs = _episode_test_runs(episode)
    episode["outcome"]["acceptedDiff"] = bool(accepted)
    episode["outcome"]["testRuns"] = {
        "passed": sum(1 for run in test_runs if run.get("exitCode") == 0),
        "failed": sum(1 for run in test_runs if run.get("exitCode") != 0),
    }
    episode["activity"] = _normalized_activity(state.get("activity") or {})
    vetoed = _session_vetoed(logical_session_id)
    candidate = None if session_kind == "host-internal" else session_bridge.build_contribution_candidate(
        episode,
        snapshot,
        accepted=accepted,
        test_runs=test_runs,
        intermediate_failure_diffs=state.get("intermediateFailureDiffs") or [],
        skill_refs=skills_loadout or [],
        publish_consent=publish_enabled,
        created_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    result = _delegate_session_end(
        episode,
        activity=state.get("activity") or {},
        eligibility_inputs={"acceptedDiff": bool(accepted)},
        contribution_candidate=candidate,
        contribution_vetoed=vetoed,
    )
    if result is None:
        fallback_path = distill.write_episode_fallback(episode)
        learning_status = (
            "pending" if tee_path is not None
            else "off" if distill.cached_mode(_runner) == "off"
            else "unavailable"
        )
        activity = state.get("activity") or {}
        _user_line(session_view.render_complete(
            summary={
                "searchedTerms": list(activity.get("searchedTerms") or []),
                "providedPackets": [
                    {"ref": ref, "title": ref} for ref in (activity.get("providedRefs") or [])
                ],
                "nothingFound": not bool(activity.get("providedRefs")),
            },
            activity=activity,
            capture_status="captured-locally" if fallback_path is not None else "unavailable",
            local_learning_status=learning_status,
            contribution=None,
            candidate_created=candidate is not None,
        ))
    else:
        contribution = result.get("contribution")
        value = contribution.get("value") if isinstance(contribution, dict) else None
        if (
            vetoed
            and isinstance(contribution, dict)
            and contribution.get("status") in ("ok", "degraded")
            and isinstance(value, dict)
            and value.get("status") == "vetoed"
        ):
            _clear_veto(logical_session_id)
        learning_status = (
            "pending" if tee_path is not None
            else "off" if distill.cached_mode(_runner) == "off"
            else "unavailable"
        )
        _user_line(session_view.render_complete(
            summary=result.get("summary"),
            activity=state.get("activity") or {},
            capture_status="captured",
            local_learning_status=learning_status,
            contribution=result.get("contribution"),
            candidate_created=candidate is not None,
        ))


# ── Slash commands ───────────────────────────────────────────────────────────

_JINN_HELP = (
    "/jinn — Jinn layer\n"
    "  /jinn status    capture + distillation state\n"
    "  /jinn doctor    environment checks — plugin build, layer, prerequisites\n"
    "  /jinn session   current searched/provided, capture, learning, and contribution state\n"
    "  /jinn history   sessions derived from episodes, contributions, and local skills\n"
    "  /jinn veto      withhold the current task (recorded locally, never published)\n"
    "  /jinn distill   local distillation — your captures into reusable skills\n"
    "  /jinn distill where local|defer|off   set where distillation runs\n"
)


def _handle_jinn(command_args: str = "", session_id: str = "", task_id: str = "", **_: Any) -> str:
    global _degraded
    parts = shlex.split(command_args or "")
    sub = parts[0] if parts else "status"

    if sub == "doctor":
        checks = doctor.run_checks(full=True, runner=_runner)
        with _contract_lock:
            # Refresh the bridge state so a fixed layer recovers mid-process
            # instead of staying degraded for the process lifetime.
            _degraded = doctor.degraded_reason(checks)
        return doctor.render(checks)

    if sub == "status":
        lines = []
        if _degraded is not None:
            lines.append(f"bridge: degraded — {_degraded}")
        d_status = distill.distill_status(_runner)
        if d_status:
            lines.append(
                f"distill: {d_status.get('mode', 'unset')} — "
                f"{d_status.get('uncoveredCount', 0)} capture(s) not yet distilled, "
                f"{d_status.get('stagedCount', 0)} staged, {d_status.get('installedCount', 0)} installed"
            )
        lines.append("contribution: parked — nothing leaves this machine")
        return "\n".join(lines)

    if sub == "session":
        state = _peek_state(session_id)
        return session_view.render_current(
            activity=state.get("activity") or {},
            capture_active=buf.has_capture(task_id, session_id),
        )

    if sub == "history":
        code, out, err = jinn_layer.history_json(runner=_runner)
        if code != 0:
            return f"history unavailable:\n{err or out}"
        try:
            reply = jinn_layer.parse_process_response(out)
        except ValueError as exc:
            return f"history unavailable:\n{exc}"
        if reply.get("status") == "unavailable":
            reason = history_view.safe_text(reply.get("reason"), "details unavailable")
            return f"history unavailable:\n{reason}"
        value = reply.get("value")
        entries = value.get("entries") if isinstance(value, dict) else None
        if not isinstance(entries, list):
            return "history unavailable:\njinn-layer response omitted history entries"
        rendered = history_view.render_history(entries)
        if reply.get("status") == "degraded":
            rendered += (
                "\n\nhistory degraded — "
                + history_view.safe_text(reply.get("reason"), "details unavailable")
            )
        return rendered

    if sub == "distill":
        # Local distillation (mono #1538) — all logic + rendering in distill.py;
        # this dispatch stays a one-liner like the other module-backed verbs.
        return distill.handle_command(parts[1:], runner=_runner)

    if sub == "veto":
        if not buf.has_steps(task_id, session_id):
            # mono issue #1383 — vetoing nothing must not return the success
            # copy: with no capture under way the mark would be a no-op.
            return "No active task to veto — veto marks the task currently running in this session."
        _record_veto(session_id)
        return (
            f"Session {session_id} is vetoed — its evidence stays local. "
            "A contribution already published is immutable."
        )

    return _JINN_HELP


def _handle_corpus(command_args: str = "", **_: Any) -> str:
    query = (command_args or "").strip()
    if not query:
        return "usage: /corpus <query> — search the public corpus"
    code, out, err = jinn_layer.corpus_search(query, runner=_runner)
    return out if code == 0 else f"corpus search failed:\n{err or out}"


# ── Agent tools — in-session corpus consumption ──────────────────────────────

_CORPUS_SEARCH_SCHEMA = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "Substring to search for (matches distribution tags and task summaries, e.g. 'tdd')."},
        "limit": {"type": "integer", "description": "Max results (default 5)."},
    },
    "required": ["query"],
}

_CORPUS_FETCH_SCHEMA = {
    "type": "object",
    "properties": {
        "ref": {"type": "string", "description": "Corpus record ref (from corpus_search results)."},
    },
    "required": ["ref"],
}


def _tool_corpus_search(args: Dict[str, Any], **_kw: Any) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        return "corpus_search requires a query."
    limit = int(args.get("limit") or 5)
    code, out, err = jinn_layer.run(["corpus", "search", query, "--json", "--limit", str(limit)], _runner)
    if code != 0:
        return f"corpus search unavailable: {err or out}"
    try:
        hits = json.loads(out)
    except json.JSONDecodeError:
        return "corpus search returned an unreadable response."
    if not isinstance(hits, list) or not hits:
        return f"No corpus records matched {query!r}."
    lines = []
    surfaced: list[str] = []
    for hit in hits[:limit]:
        if not isinstance(hit, dict):
            continue
        ref = str(hit.get("ref") or "").strip()
        tags = ",".join(hit.get("tags") or []) or "-"
        summary = str(hit.get("summary") or hit.get("title") or "")[:100]
        lines.append(f"ref={ref} tags=[{tags}] {summary}")
        if ref:
            surfaced.append(ref)
    _record_activity(str(_kw.get("session_id") or ""), "surfacedRefs", surfaced)
    lines.append("Use corpus_fetch with a ref to read the full content.")
    return "\n".join(lines)


def _tool_corpus_fetch(args: Dict[str, Any], **_kw: Any) -> str:
    ref = str(args.get("ref") or "").strip()
    if not ref:
        return "corpus_fetch requires a ref."
    code, out, err = jinn_layer.run(["corpus", "get", ref, "--json"], _runner)
    if code != 0:
        return f"corpus get unavailable: {err or out}"
    try:
        record = json.loads(out)
        trace, _sha = skills_install._extract_trace(record)
    except Exception as exc:
        return f"record is not readable as an evidence envelope: {exc}"
    _record_activity(str(_kw.get("session_id") or ""), "fetchedRefs", [ref])
    tier = str(((trace.get("outcome") or {}).get("verifiabilityTier")) or "unknown")
    summary = str(((trace.get("task") or {}).get("summary")) or "")
    steps = trace.get("steps") or []
    skill_md = None
    for step in steps:
        attrs = step.get("attributes") if isinstance(step, dict) else None
        if isinstance(attrs, dict) and isinstance(attrs.get("skill.md"), str):
            skill_md = attrs["skill.md"]
            break
    header = f"[{tier}] {summary}"
    if skill_md is not None:
        body = skill_md[:8000]
        return f"{header}\n\n{body}"
    return f"{header}\n\n(trace envelope with {len(steps)} steps; no skill.md payload)"


# ── Registration ─────────────────────────────────────────────────────────────

def register(ctx) -> None:
    # Stock Hermes clones the slim plugin but has no dependency-install hook.
    # Acquire the exact published layer into the plugin-owned npm prefix on
    # first registration. Source-tree dogfood keeps using explicit overrides.
    try:
        jinn_layer.prepare_installed_plugin_runtime()
    except jinn_layer.LayerResolutionError as exc:
        logger.warning("Jinn layer runtime bootstrap failed: %s", exc)

    # Establish the fail-closed boundary as soon as an enabled plugin is
    # registered, before the first session can create or inspect a candidate.
    # The first session additionally asks the layer to rewrite queued records.
    session_bridge.set_publication_enabled(False)
    ctx.register_tool(
        name="corpus_search",
        toolset="jinn",
        schema=_CORPUS_SEARCH_SCHEMA,
        handler=_tool_corpus_search,
        description="Search the public Jinn corpus by content (distribution tags + task summaries). Use when the task type looks like something the network may already have knowledge about.",
    )
    ctx.register_tool(
        name="corpus_fetch",
        toolset="jinn",
        schema=_CORPUS_FETCH_SCHEMA,
        handler=_tool_corpus_fetch,
        description="Fetch a corpus record by ref (hash-verified) and read its content in-session — e.g. a published skill's full text.",
    )
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_command(
        "jinn",
        handler=_handle_jinn,
        description="Jinn layer: session, history, and corpus state.",
    )
    ctx.register_command(
        "corpus",
        handler=_handle_corpus,
        description="Search the public Jinn corpus.",
    )
    # `jinn-agent jinn-doctor` — the doctor without a TUI session (mono #1817).
    # NOT named `doctor`: that collides with the built-in hermes subcommand
    # and would silently disable discovery of every plugin CLI command.
    ctx.register_cli_command(
        "jinn-doctor",
        help="Jinn environment checks — plugin build, layer, prerequisites.",
        setup_fn=doctor.setup_parser,
        handler_fn=doctor.cli_handler,
        description="Print-only doctor: [ok]/[fail] per check, one copy-paste remedy per failure.",
    )
