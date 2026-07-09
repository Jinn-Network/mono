#!/usr/bin/env python3
"""``/distill`` -- build the prompt for local trace skill distillation.

The command is intentionally a normal agent turn. The user's active model reads
local session traces with the existing ``session_search`` tool, then writes or
updates one skill through ``skill_manage``. No separate distillation service is
required for jinn-agent.
"""

from __future__ import annotations

from agent.learn_prompt import _AUTHORING_STANDARDS


def _mode_for_request(user_request: str) -> tuple[str, str]:
    req = (user_request or "").strip()
    if not req:
        return (
            "this",
            "this session and the current conversation -- distill the workflow "
            "we just performed into one reusable skill if there is enough signal",
        )
    lowered = req.lower()
    if lowered in {"this", "current", "recent"}:
        return (
            lowered,
            "this session and the current conversation -- use recent session "
            "cards only to orient yourself if the current transcript is not enough",
        )
    if lowered == "all":
        return (
            "all",
            "all recent local traces, using a capped first pass to find repeated "
            "skill opportunities before reading any transcript deeply",
        )
    return ("selected", req)


def build_distill_prompt(user_request: str) -> str:
    """Build the agent prompt for ``/distill``.

    Args:
        user_request: Text after ``/distill``. Empty means ``this``; ``all`` asks
            for a capped scan over recent sessions; anything else is treated as
            a trace id, session id, query, or natural-language scope.
    """
    mode, scope = _mode_for_request(user_request)

    return (
        "[/distill] The user wants you to distill local work traces into a "
        "reusable skill and save it.\n\n"
        f"MODE: {mode}\n"
        f"SCOPE: {scope}\n\n"
        "Argument semantics:\n"
        "- No argument means `this`: focus on this session and the current "
        "conversation.\n"
        "- `this`, `current`, or `recent` means use the current session first, "
        "then inspect recent session cards only if needed.\n"
        "- `all` means run a capped scan over recent local traces, cluster "
        "recurring work patterns, present candidate skills, and ask the user "
        "which one to distill before doing a broad or expensive read.\n"
        "- Any other text is a trace id, session id, query, or scope to use "
        "for finding the relevant local traces.\n\n"
        "Trace workflow:\n"
        "1. For `this`, start from the current conversation already in context. "
        "If you need more context, call `session_search()` with no query to "
        "list recent sessions, or call `session_search(session_id=...)` for a "
        "specific session.\n"
        "2. For `all`, begin with `session_search(query=\"skill reusable workflow\", "
        "limit=50, sort=\"newest\")` or a similarly broad capped search. Do not "
        "read full transcripts first. Use compact results to cluster candidate "
        "skill opportunities.\n"
        "3. For a query or selected scope, call `session_search(query=..., "
        "limit=10)` first, then use `session_search(session_id=..., "
        "around_message_id=..., window=...)` for only the relevant portions.\n"
        "4. Read only what is needed. Prefer summaries, matched windows, tool "
        "calls, and nearby messages. Full transcript reads are last resort.\n"
        "5. Before writing a skill from `all`, summarize the candidate cluster "
        "and ask the user to choose or approve the specific skill to distill.\n"
        "6. Author or update exactly one skill with `skill_manage`. If a "
        "non-trivial helper is needed, write it under the skill's `scripts/` "
        "directory and reference it from SKILL.md.\n\n"
        "Reuse the existing Jinn distillation methodology rather than "
        "inventing a new one:\n"
        "- Prefer user-accepted successful traces for success patterns.\n"
        "- Use failed or abandoned traces only for concrete pitfalls, recovery "
        "steps, and failure avoidances.\n"
        "- Ground the skill in repeated evidence when available; label a "
        "single-trace result as experimental.\n"
        "- Preserve provenance in the skill metadata or in the final summary: "
        "which session ids, trace ids, or queries informed the result.\n"
        "- Keep private trace content local unless the user explicitly asks "
        "for a future publish or marketplace flow.\n\n"
        f"{_AUTHORING_STANDARDS}\n\n"
        "When done, tell the user the skill name, where it was saved, the "
        "trace provenance used, and one short note about how to judge whether "
        "the skill helped next time."
    )


def distill_ack(user_request: str) -> str:
    """Short user-facing acknowledgement before the agent turn starts."""
    mode, _scope = _mode_for_request(user_request)
    if mode == "all":
        return "Scanning recent local sessions for distillable skill candidates..."
    if mode in {"this", "current", "recent"}:
        return "Distilling a reusable skill from this session..."
    return "Distilling a reusable skill from the requested traces..."
