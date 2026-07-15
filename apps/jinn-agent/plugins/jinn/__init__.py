"""jinn plugin — the Jinn-Hermes fork's single integration surface.

Thin-fork discipline: everything that touches scrubbing, consent
conversion, publishing, anchoring, the ledger or the corpus lives in the
``@jinn-network/harness-layer`` package (the ``jinn-layer`` CLI); this
plugin only:

1. Runs the first-run consent flow (``/jinn consent``; exact copy from the
   design artifact). Consent default is OFF — ``unset`` and ``declined``
   both mean nothing is captured, nothing leaves the machine.
2. Buffers the session's task trace (``pre_llm_call`` first turn +
   ``post_tool_call`` steps) and, at ``on_session_end`` — only when consent
   is ``accepted`` — hands the assembled task to ``jinn-layer``:
   preview-gated first publish, per-task veto, fail-closed scrub inside
   the layer.
3. Exposes ``/jinn`` (status · consent · preview · ledger · veto) and
   ``/corpus <query>`` (in-session corpus search).

Upstream-merge procedure: see JINN.md at the repo root.
"""

from __future__ import annotations

import json
import logging
import shlex
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Set

from . import capture_buffer as buf
from . import consent
from . import distill
from . import jinn_layer
from . import ledger_view
from . import onboarding
from . import pickup
from . import skills_install

logger = logging.getLogger(__name__)

PUBLISH_FAILED_LINE = "publish failed — retained locally"

_veto_lock = threading.Lock()
_vetoed_tasks: Set[str] = set()
_session_hint_shown: Set[str] = set()

# Test seam: overridable subprocess runner (None = real jinn-layer binary).
_runner: Optional[jinn_layer.Runner] = None


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


def _published_ref(out: str) -> str:
    """Extract the envelopeRef from jinn-layer publish output.

    Success output is ``Published.\\n  ref       <envelopeRef>\\n  …``
    (harness-layer cli.ts). Empty string when absent — callers omit it.
    """
    for line in (out or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "ref":
            return parts[1]
    return ""


def _task_key(task_id: str, session_id: str) -> str:
    return task_id or session_id or "default"


# ── Hooks ────────────────────────────────────────────────────────────────────

def _on_session_start(session_id: str = "", platform: str = "", **_: Any) -> None:
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
        return pickup.pickup(user_message, runner=_runner)
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

    # Dual-write the complete-trajectory EpisodeV1 to its own dir (mono #1662),
    # local capture so unconditional, best-effort (never breaks the session
    # end). Written before the legacy None-guard so a turn-only session (no tool
    # call) still emits its ≥1-turn episode.
    distill.write_episode(episode, session_id or task_id, runner=_runner)

    if task is None:
        return

    # Tee for local distillation (mono #1537) — BEFORE the veto/publish
    # branching, so held, vetoed and published tasks all reserve a local
    # capture (a veto withholds from the NETWORK; local distillation never
    # leaves this machine). Distinct dir + lifecycle from the pending file:
    # the publish drain unlinks pending files, never captures.
    distill.tee_capture(task, session_id or task_id, runner=_runner)

    # Everything below is the SHARE lifecycle (a task leaving the machine) —
    # gated on the single share consent alone. Local capture/distill above is
    # never gated.
    if not share_enabled:
        return

    task_file = jinn_layer.write_task_file(task, _pending_dir(), session_id or task_id)

    with _veto_lock:
        vetoed = _task_key(task_id, session_id) in _vetoed_tasks
        _vetoed_tasks.discard(_task_key(task_id, session_id))

    if vetoed:
        code, out = jinn_layer.publish(task_file, veto=True, runner=_runner)
        if code == 0:
            task_file.unlink(missing_ok=True)
            logger.info("jinn: task vetoed — recorded locally, nothing published")
        else:
            logger.warning("jinn: veto record failed: %s", out)
        return

    if not consent.load_state().get("previewed"):
        # Design rule: nothing publishes until the operator has previewed once.
        logger.info(
            "jinn: trace captured and held locally at %s — run /jinn preview to "
            "see exactly what would publish, then it publishes on future task ends",
            task_file,
        )
        _user_line("jinn: trace held locally — /jinn preview to see what would publish")
        return

    code, out = jinn_layer.publish(task_file, runner=_runner)
    if code == 0:
        task_file.unlink(missing_ok=True)
        logger.info("jinn: contribution published\n%s", out)
        ref = _published_ref(out)
        _user_line(
            f"jinn: contribution published — {ref} (/jinn ledger for the anchor)"
            if ref
            else "jinn: contribution published (/jinn ledger for the anchor)"
        )
    else:
        logger.warning("jinn: %s (%s)\n%s", PUBLISH_FAILED_LINE, task_file, out)
        _user_line(f"jinn: publish failed — trace kept at {task_file}")

    _drain_pending(task_file)


def _drain_pending(current: Path) -> None:
    """Publish traces held in the pending dir by earlier session ends.

    The preview gate holds pre-preview tasks with the promise "then it
    publishes on future task ends" — this drain keeps that promise
    (mono issue #1370). Runs only from the publishing path of
    ``_on_session_end`` (consent accepted + previewed), so vetoed files
    are never drained: a veto is recorded and unlinked in the veto branch
    above, which returns early before any drain — acceptable, because the
    drain simply happens on the next publishing session end. Failures are
    logged and the file left for a retry at a later session end; a drain
    must never raise or block the session end.
    """
    try:
        held = sorted(
            (p for p in _pending_dir().glob("*.json") if p != current),
            key=lambda p: p.stat().st_mtime,
        )
    except OSError:
        return
    drained = 0
    for path in held:
        try:
            code, out = jinn_layer.publish(path, runner=_runner)
            if code == 0:
                path.unlink(missing_ok=True)
                drained += 1
                logger.info("jinn: held contribution published\n%s", out)
            else:
                logger.warning("jinn: %s (%s)\n%s", PUBLISH_FAILED_LINE, path, out)
        except Exception:
            logger.warning("jinn: %s (%s)", PUBLISH_FAILED_LINE, path, exc_info=True)
    if drained:
        # One summary line for the whole drain — with the current task's own
        # line above, a session end emits at most 2 user-visible lines.
        _user_line(f"jinn: {drained} held trace(s) published")


# ── Slash commands ───────────────────────────────────────────────────────────

_JINN_HELP = (
    "/jinn — Jinn layer\n"
    "  /jinn status    consent + capture state\n"
    "  /jinn consent   run the consent flow\n"
    "  /jinn preview   preview the held (pending) trace exactly as it would publish\n"
    "  /jinn ledger    the contribution ledger — what left this machine\n"
    "  /jinn veto      withhold the current task (recorded locally, never published)\n"
    "  /jinn skills install <ref>   install a corpus-published skill into the agent's skills\n"
    "  /jinn skills list            jinn-installed skills\n"
    "  /jinn skills uninstall <slug>  remove a jinn-installed skill\n"
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
            lines.append(f"previewed: {'yes' if state.get('previewed') else 'no — first share is held until /jinn preview'}")
            lines.append("share: ON — reproducible tasks from your work may be shared at task end")
        else:
            lines.append("share: OFF — nothing derived from your work leaves this machine")
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
            return consent.record_accept() if confirmed else consent.confirm_accept_command()
        if action == "decline":
            return consent.record_decline() if confirmed else consent.confirm_decline_command()
        return consent.render_explainer(consent.COMMANDS_LINE)

    if sub == "preview":
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
            return out + "\n\npreview recorded — future task ends publish automatically."
        return f"preview failed:\n{out}"

    if sub == "ledger":
        # Prefer structured rows (design 1b columns + tier chips + retry
        # sub-line + exact empty state). Degrade to the layer's raw text when
        # the installed layer predates `ledger --json`.
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

    if sub == "veto":
        if not buf.has_steps(task_id, session_id):
            # mono issue #1383 — vetoing nothing must not return the success
            # copy: with no capture under way the mark would be a no-op.
            return "No active task to veto — veto marks the task currently running in this session."
        with _veto_lock:
            _vetoed_tasks.add(_task_key(task_id, session_id))
        return "This task is vetoed — its trace stays on this machine (ledger will show: vetoed (local only))."

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
    for hit in hits[:limit]:
        if not isinstance(hit, dict):
            continue
        tags = ",".join(hit.get("tags") or []) or "-"
        summary = str(hit.get("summary") or hit.get("title") or "")[:100]
        lines.append(f"ref={hit.get('ref')} tags=[{tags}] {summary}")
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
        description="Jinn layer: consent, preview, ledger, veto.",
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
