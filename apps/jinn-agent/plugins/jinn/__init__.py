"""jinn plugin — the Jinn-Hermes fork's single integration surface.

The plugin captures local session evidence unconditionally, assembles one
complete EpisodeV1, and delegates it through the versioned ``jinn-layer
session end`` process bridge.  The core owns canonical persistence,
eligibility, contribution recording/veto, and summaries.  A bridge failure
falls back to one local EpisodeV1 write; the retired raw pending/publication
queue is never created or drained here.

Sharing remains governed by the single consent bit, and ``/jinn`` exposes
status, consent, informational preview, ledger, veto, and corpus consumption.

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

from . import capture_buffer as buf
from . import consent
from . import distill
from . import history_view
from . import jinn_layer
from . import ledger_view
from . import onboarding
from . import pickup
from . import session_bridge
from . import session_view
from . import skills_install

logger = logging.getLogger(__name__)

_veto_lock = threading.Lock()
_vetoed_tasks: Set[str] = set()
_session_hint_shown: Set[str] = set()

# Test seam: overridable subprocess runner (None = real jinn-layer binary).
_runner: Optional[jinn_layer.Runner] = None

# Memoized v1 handshake. A reason here disables only the additive session-end
# process bridge; Python pickup, capture, fallback persistence, and distillation
# remain live.
_contract_lock = threading.Lock()
_contract_checked = False
_degraded: Optional[str] = None

# Per-session repo/activity evidence. Populated at session start and consumed
# once at session end.
_session_state_lock = threading.Lock()
_session_states: Dict[str, Dict[str, Any]] = {}


def _reset_contract_state() -> None:
    global _contract_checked, _degraded
    _contract_checked = False
    _degraded = None


def _reset_session_state() -> None:
    with _session_state_lock:
        _session_states.clear()


def _check_contract() -> None:
    """Probe contract v1 once; never raise into the host session."""
    global _contract_checked, _degraded
    with _contract_lock:
        if _contract_checked:
            return
        _contract_checked = True
        try:
            code, out = jinn_layer.contract(runner=_runner)
        except Exception:
            _degraded = "jinn-layer handshake failed"
            return
        if code == 127:
            _degraded = "jinn-layer unavailable"
            return
        if code != 0:
            _degraded = "jinn-layer handshake failed"
            return
        try:
            reply = json.loads(out)
        except (TypeError, json.JSONDecodeError):
            _degraded = "jinn-layer contract unreadable"
            return
        version = reply.get("contractVersion") if isinstance(reply, dict) else None
        if version != jinn_layer.CONTRACT_VERSION:
            _degraded = (
                f"jinn-layer contract v{version} "
                f"(expected v{jinn_layer.CONTRACT_VERSION})"
            )


def _pending_dir() -> Path:
    return consent.get_hermes_home() / "jinn" / "pending"


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
    """
    try:
        print(msg, file=sys.stderr, flush=True)
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


def _state_for(session_id: str, cwd: Optional[Path] = None) -> Dict[str, Any]:
    key = session_id or "default"
    with _session_state_lock:
        state = _session_states.get(key)
        if state is None:
            state = {
                "snapshot": session_bridge.snapshot_repository(key, cwd=cwd),
                "activity": {
                    "surfacedRefs": [],
                    "fetchedRefs": [],
                    "installedSkillRefs": [],
                },
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
                "activity": {
                    "surfacedRefs": [],
                    "fetchedRefs": [],
                    "installedSkillRefs": [],
                },
                "intermediateFailureDiffs": [],
            },
        )


def _peek_state(session_id: str) -> Dict[str, Any]:
    key = session_id or "default"
    with _session_state_lock:
        state = _session_states.get(key)
        if state is None:
            return {
                "activity": {
                    "surfacedRefs": [],
                    "fetchedRefs": [],
                    "installedSkillRefs": [],
                },
            }
        return {
            **state,
            "activity": {
                field: list(state.get("activity", {}).get(field) or [])
                for field in ("surfacedRefs", "fetchedRefs", "installedSkillRefs")
            },
        }


def _record_activity(session_id: str, field: str, refs: list[str]) -> None:
    """Record only refs a successful host action actually observed."""
    if not session_id or field not in ("surfacedRefs", "fetchedRefs", "installedSkillRefs"):
        return
    state = _state_for(session_id)
    with _session_state_lock:
        seen = state["activity"][field]
        for ref in refs:
            if ref and ref not in seen:
                seen.append(ref)


# ── Hooks ────────────────────────────────────────────────────────────────────

def _on_session_start(session_id: str = "", platform: str = "", **_: Any) -> None:
    cwd = _.get("cwd") or _.get("working_directory")
    _state_for(session_id, Path(cwd) if isinstance(cwd, str) and cwd else None)
    _check_contract()
    if consent.consent_decided():
        return
    if session_id in _session_hint_shown:
        return
    _session_hint_shown.add(session_id)
    # Never block a session with an interactive flow from inside a hook —
    # surface the one-line hint; the flow itself runs via /jinn consent.
    logger.info(
        "jinn: sharing consent not set — nothing is shared. Run /jinn consent to decide."
    )


def _on_pre_llm_call(
    session_id: str = "",
    user_message: str = "",
    is_first_turn: bool = False,
    model: str = "",
    platform: str = "",
    task_id: str = "",
    **_: Any,
) -> Optional[Dict[str, str]]:
    # Local capture — UNCONDITIONAL (mono#1714): filling the buffer never
    # leaves the machine; local retention, mining, and distillation happen by
    # default. Not gated on is_first_turn: the buffer is keyed per session and
    # record_first_turn is setdefault-idempotent, so calling it every turn
    # recovers the summary/model even when the first-turn signal is unreliable
    # on some provider paths (mono #1404). Only the share step (a task leaving
    # the machine) is gated — see _on_session_end.
    buf.record_first_turn(task_id, session_id, user_message, model, platform)
    # Ordered user-turn span for the EpisodeV1 trajectory (mono #1662).
    # record_first_turn stores metadata only; this appends the turn span so it
    # precedes this turn's tool calls (post_tool_call) and the assistant turn
    # (post_llm_call). Local capture, so unconditional per mono#1714.
    buf.record_user_turn(task_id, session_id, user_message)
    # Consumption side — NEVER consent-gated: payload-agnostic corpus pickup.
    # Returns {"context": ...} (injected into the user message, cache-safe)
    # or None. Fails open inside pickup().
    if is_first_turn:
        state = _state_for(session_id)
        return pickup.pickup(user_message, runner=_runner, activity=state["activity"])
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
    # Local capture — UNCONDITIONAL (mono#1714): recording tool calls never
    # leaves the machine.
    buf.record_tool_call(task_id, session_id, tool_name, tool_call_id, args, result, duration_ms)
    state = _state_for(session_id)
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
    # Complete the EpisodeV1 turn (mono #1662): the assistant span lands AFTER
    # this turn's tool calls (post_tool_call fires inside the tool loop, which
    # completes before post_llm_call). Local capture is UNCONDITIONAL (mono#1714)
    # — the buffer never leaves the machine; only the share step is gated.
    buf.record_assistant_turn(task_id, session_id, assistant_response)
    # Record tokens only when the host reports meaningful usage. Zero/zero (the
    # getattr default when the agent has no usage) is treated as "no usage" so
    # cost.tokens is OMITTED rather than emitted as {0,0} (AC2, mono #1662).
    if input_tokens or output_tokens:
        buf.record_tokens(task_id, session_id, input_tokens or 0, output_tokens or 0)


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
    normalized_activity = {
        "surfacedRefs": list(activity.get("surfacedRefs") or []),
        "fetchedRefs": list(activity.get("fetchedRefs") or []),
        "installedSkillRefs": list(activity.get("installedSkillRefs") or []),
    }
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
        code, out = jinn_layer.session_end(request, runner=_runner)
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
    # Local capture is unconditional (mono#1714); only the share step is gated.
    share_enabled = consent.share_enabled()
    # Record the skills loadout + token fallback (host forward, mono #1662) —
    # local writes, so unconditional per mono#1714, before the popping assembly.
    buf.record_environment(task_id, session_id, skills_loadout or [])
    # See _on_post_llm_call — zero/no usage omits cost.tokens (AC2, mono #1662).
    if input_tokens or output_tokens:
        buf.record_tokens(task_id, session_id, input_tokens or 0, output_tokens or 0)

    # Pop the buffer ONCE for both shapes (assemble pops — see assemble_both).
    # publish_consented mirrors the single share consent (mono#1714): the
    # network-facing shape is only prepared when the operator has consented.
    task, episode = buf.assemble_both(
        task_id, session_id, completed, interrupted, publish_consented=share_enabled
    )

    if episode is None:
        state = _pop_state(session_id)
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

    state = _pop_state(session_id)
    snapshot = state.get("snapshot")
    try:
        accepted = session_bridge.accepted_diff(snapshot) if snapshot is not None else ""
    except Exception:
        accepted = ""
    vetoed = _session_vetoed(session_id)
    candidate = session_bridge.build_contribution_candidate(
        episode,
        snapshot,
        accepted=accepted,
        test_runs=_episode_test_runs(episode),
        intermediate_failure_diffs=state.get("intermediateFailureDiffs") or [],
        skill_refs=skills_loadout or [],
        publish_consent=share_enabled,
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
        _user_line(session_view.render_complete(
            summary={
                **(state.get("activity") or {}),
                "nothingFound": not bool(
                    (state.get("activity") or {}).get("surfacedRefs")
                ),
            },
            activity=state.get("activity") or {},
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
            _clear_veto(session_id)
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
    "  /jinn status    consent + capture state\n"
    "  /jinn consent   run the consent flow\n"
    "  /jinn preview   inspect a retained legacy capture, or a labelled example\n"
    "  /jinn session   current surfaced, capture, learning, and contribution state\n"
    "  /jinn history   sessions derived from episodes, contributions, and local skills\n"
    "  /jinn ledger    the contribution ledger — what left this machine\n"
    "  /jinn veto      withhold the current task (recorded locally, never published)\n"
    "  /jinn skills install <ref>   install a corpus-published skill into the agent's skills\n"
    "  /jinn skills list            jinn-installed skills\n"
    "  /jinn skills uninstall <slug>  remove a jinn-installed skill\n"
    "  /jinn distill   local distillation — your captures into reusable skills\n"
    "  /jinn distill where local|defer|off   set where distillation runs\n"
)


def _latest_pending() -> Optional[Path]:
    directory = _pending_dir()
    if not directory.exists():
        return None
    files = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def _handle_jinn(command_args: str = "", session_id: str = "", task_id: str = "", **_: Any) -> str:
    parts = shlex.split(command_args or "")
    sub = parts[0] if parts else "status"

    if sub == "status":
        state = consent.load_state()
        share = bool(state.get("shareConsent"))
        lines = [f"sharing: {'ON' if share else 'OFF'}"]
        if share:
            lines.append(f"previewed: {'yes' if state.get('previewed') else 'no'}")
            lines.append("share: ON — reproducible tasks from your work may be shared at task end")
        else:
            lines.append("share: OFF — nothing derived from your work leaves this machine")
        if _degraded is not None:
            lines.append(f"bridge: degraded — {_degraded}")
        pending = _latest_pending()
        if pending:
            lines.append(f"pending trace: {pending}")
        return "\n".join(lines)

    if sub == "consent":
        # TUI-safe: stateless commands, never blocking reads. Same deliberate
        # two-step as the design's keyboard flow (idle -> confirming -> recorded).
        action = parts[1] if len(parts) > 1 else ""
        confirmed = len(parts) > 2 and parts[2] == "confirm"
        if action == "accept":
            if not confirmed:
                return consent.confirm_accept_command()
            marker_ok = session_bridge.set_publication_enabled(True)
            message = consent.record_accept()
            return message if marker_ok else message + "\nwarning: publication preference marker could not be updated"
        if action == "decline":
            if not confirmed:
                return consent.confirm_decline_command()
            code, out = jinn_layer.contribution_disable(runner=_runner)
            # Let the core serialize revocation with any publication already
            # crossing its boundary. The direct marker is the fail-closed host
            # fallback and mirrors the successful core write for old stubs.
            marker_ok = session_bridge.set_publication_enabled(False)
            message = consent.record_decline()
            if code == 0:
                return message
            if marker_ok:
                return message + "\nexisting publication queue is fail-closed locally; jinn-layer cleanup is degraded"
            return message + f"\nwarning: could not disable the existing publication queue: {out}"
        return consent.render_explainer(consent.COMMANDS_LINE)

    if sub == "preview":
        code, out = jinn_layer.contribution_preview(acknowledge=True, runner=_runner)
        if code == 0:
            try:
                reply = jinn_layer.parse_process_response(out)
                value = reply.get("value")
                if isinstance(value, dict):
                    consent.mark_previewed()
                    lines = [
                        "Jinn public-task preview",
                        f"repository: {value.get('repositorySlug', 'unavailable')}",
                        f"base commit: {value.get('baseCommit', 'unavailable')}",
                        "shared after validation: public task definition and test contract",
                        "stays local: raw trajectory, source id, accepted diff/gold, failures, skills, and holdouts",
                        "preview acknowledged — this and later eligible public tasks may queue silently",
                    ]
                    if reply.get("status") == "degraded":
                        lines.append(f"bridge degraded: {reply.get('reason', 'details unavailable')}")
                    return "\n".join(lines)
            except (TypeError, ValueError):
                pass
        pending = _latest_pending()
        if pending is None:
            # Design requirement iv: preview is reachable before any publish.
            # With no task yet, show the labelled example fixture rather than
            # an empty screen. Does not mark previewed — the real gate stays
            # on a real trace.
            return consent.render_preview_example()
        code, out = jinn_layer.capture_preview(pending, runner=_runner)
        if code == 0:
            consent.mark_previewed()
            return out + "\n\nlegacy preview only — this retained file will not auto-publish."
        return f"preview failed:\n{out}"

    if sub == "session":
        state = _peek_state(session_id)
        return session_view.render_current(
            activity=state.get("activity") or {},
            capture_active=buf.has_capture(task_id, session_id),
            share_enabled=consent.share_enabled(),
        )

    if sub == "history":
        code, out = jinn_layer.history_json(runner=_runner)
        if code != 0:
            return f"history unavailable:\n{out}"
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

    if sub == "ledger":
        # Prefer canonical contribution-store rows. A layer that predates the
        # command falls back to the legacy publication-receipt ledger.
        ccode, cout = jinn_layer.contribution_ledger_json(runner=_runner)
        if ccode == 0:
            try:
                reply = jinn_layer.parse_process_response(cout)
            except ValueError:
                reply = None
            if isinstance(reply, dict):
                if reply.get("status") == "unavailable":
                    return f"contribution ledger unavailable:\n{reply.get('reason', 'details unavailable')}"
                rows = ledger_view.rows_from_json(reply.get("value"))
                if rows is not None:
                    rendered = ledger_view.render_ledger(
                        rows, enabled=consent.share_enabled()
                    )
                    if reply.get("status") == "degraded":
                        rendered += (
                            "\n\ncontribution state degraded — "
                            + str(reply.get("reason") or "details unavailable")
                        )
                    return rendered

        # Prefer structured legacy rows (design 1b columns + tier chips +
        # exact empty state), then degrade to the layer's raw text.
        jcode, jout = jinn_layer.ledger_json(runner=_runner)
        if jcode == 0:
            try:
                rows = ledger_view.rows_from_json(json.loads(jout))
            except json.JSONDecodeError:
                rows = None
            if rows is not None:
                return ledger_view.render_ledger(rows, enabled=consent.share_enabled())
        code, out = jinn_layer.ledger(runner=_runner)
        return out if code == 0 else f"ledger unavailable:\n{out}"

    if sub == "skills":
        # Consuming is always allowed — no consent check on this entire path.
        action = parts[1] if len(parts) > 1 else "list"
        if action == "install":
            if len(parts) < 3:
                return "usage: /jinn skills install <ref> (a corpus ref from /corpus search)"
            try:
                path = skills_install.install(parts[2], runner=_runner)
            except Exception as exc:
                return f"install failed: {exc}"
            _record_activity(session_id, "installedSkillRefs", [parts[2]])
            return f"installed — {path}\nThe agent's skill loader picks it up from here."
        if action == "uninstall":
            if len(parts) < 3:
                return "usage: /jinn skills uninstall <slug>"
            try:
                skills_install.uninstall(parts[2])
            except Exception as exc:
                return f"uninstall failed: {exc}"
            return f"uninstalled {parts[2]}."
        installed = skills_install.list_installed()
        if not installed:
            return "No jinn-installed skills. /corpus <query> to find some, then /jinn skills install <ref>."
        return "\n".join(f"{row['slug']}  ({row['ref'] or 'ref unknown'})" for row in installed)

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
    code, out = jinn_layer.corpus_search(query, runner=_runner)
    return out if code == 0 else f"corpus search failed:\n{out}"


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
    code, out = jinn_layer.run(["corpus", "search", query, "--json", "--limit", str(limit)], _runner)
    if code != 0:
        return f"corpus search unavailable: {out}"
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
    code, out = jinn_layer.run(["corpus", "get", ref, "--json"], _runner)
    if code != 0:
        return f"corpus get unavailable: {out}"
    try:
        record = json.loads(out)
        trace, _sha = skills_install._extract_trace(record)
    except Exception as exc:
        return f"record is not readable as a trace envelope: {exc}"
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
        description="Jinn layer: session, history, consent, and contribution state.",
    )
    ctx.register_command(
        "corpus",
        handler=_handle_corpus,
        description="Search the public Jinn corpus.",
    )
    # `jinn-agent onboarding [--replay]` — the guided first run (mono#1405).
    # A terminal subcommand (blocking reads), NOT a slash command: the flow
    # reuses consent.run_consent_flow, whose input() would deadlock a TUI
    # session. Returning operators (consent recorded + ledger non-empty) get
    # a no-op; --replay re-renders without re-asking.
    ctx.register_cli_command(
        "onboarding",
        help="Guided first-run onboarding (consent → publish → rewards → signals).",
        setup_fn=onboarding.setup_parser,
        handler_fn=onboarding.cli_handler,
        description="Walk the core loop once, one confirmed step at a time. --replay re-shows it.",
    )
