"""Local trace distiller plugin.

Registers ``/distill`` as a plugin-owned command. The plugin does not run a
separate model. It builds an instruction prompt and asks the host harness to
run that prompt through the user's active agent turn, where the local-distil
MCP tools are available.
"""

from __future__ import annotations

from typing import Any

from hermes_cli.plugins import plugin_command_agent_turn


_DISTILL_AUTHORING_STANDARDS = (
    "Skill authoring standards:\n"
    "- Emit a normal SKILL.md package through the local distillation flow.\n"
    "- Frontmatter name must be lowercase-hyphenated, <=64 chars, with no spaces.\n"
    "- Description must be one sentence, <=60 chars, and state the capability.\n"
    "- Include version 0.1.0 and avoid environment-derived author names.\n"
    "- Use a fixed, scannable body: title, When to Use, Prerequisites, "
    "How to Run, Quick Reference, Procedure, Pitfalls, Verification.\n"
    "- Keep generated prose grounded in the selected trace evidence. Do not "
    "invent flags, APIs, files, or commands not supported by the traces.\n"
    "- Put non-trivial helper code inside the generated skill package and "
    "reference it from SKILL.md by relative path.\n"
)


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
        "Required tools: `distill_trace_search`, `distill_trace_read`, "
        "`distill_trace_cluster`, `distill_local`, and "
        "`distill_feedback_record`. If the host has not exposed these tools, "
        "stop and tell the user the local trace distiller plugin installation "
        "is incomplete; do not use another trace-mining path.\n\n"
        "Trace workflow:\n"
        "1. Use the local trace distiller MCP tools: `distill_trace_search` "
        "for compact cards, `distill_trace_cluster` for capped "
        "recurring-signal discovery, `distill_trace_read` for scoped reads, "
        "and `distill_local` only after the user approves a specific "
        "distillation run.\n"
        "2. For `this`, start with `distill_trace_search(scope=\"this\")`. "
        "Read only the selected trace windows needed to derive the candidate "
        "skill.\n"
        "3. For `all`, begin with `distill_trace_cluster(limit=50)`. Do not "
        "read full transcripts first. Use compact results to cluster candidate "
        "skill opportunities.\n"
        "4. For a query or selected scope, search first, then read only the "
        "relevant portions with `distill_trace_read`.\n"
        "5. Read only what is needed. Prefer summaries, matched windows, tool "
        "calls, and nearby messages. Full transcript reads are last resort.\n"
        "6. Before writing a skill from `all`, summarize the candidate cluster "
        "and ask the user to choose or approve the specific skill to distill.\n"
        "7. Author or update exactly one skill with `distill_local(confirm=true)` "
        "after approval. If a non-trivial helper is needed, keep it inside the "
        "generated skill package and reference it from SKILL.md.\n\n"
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
        f"{_DISTILL_AUTHORING_STANDARDS}\n"
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


def _handle_distill(command_args: str = "", **_: Any) -> dict[str, str]:
    return plugin_command_agent_turn(
        build_distill_prompt(command_args),
        message=distill_ack(command_args),
    )


def register(ctx) -> None:
    ctx.register_command(
        "distill",
        handler=_handle_distill,
        description="Distill a reusable skill from local traces.",
        args_hint="[this|all|trace/session/query]",
    )
