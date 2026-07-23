"""Per-task capture buffer — assembles a CapturedTask for the Jinn layer.

The plugin records the first user message (``pre_llm_call``) and every tool
call (``post_tool_call``) into an in-memory buffer keyed by task/session,
then assembles the ``CapturedTask`` JSON that ``jinn-layer`` consumes
(``packages/core/src/captured-task.ts`` ``CapturedTaskSchema`` in
the mono repo). Attributes are recorded RAW here — the mandatory,
fail-closed scrub happens inside ``jinn-layer capture``/``publish`` on this
machine, before anything can leave it.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from . import harness as _harness

_lock = threading.Lock()
_buffers: Dict[object, Dict[str, Any]] = {}
_ALL_LIFECYCLES = object()


def _session_key(task_id: str, session_id: str) -> str:
    # Key on the session, which is stable for the whole conversation. task_id is
    # a fresh per-turn uuid on the interactive path (the agent mints one when no
    # explicit task is set), so keying on it fragments a session's trace across
    # buffers — record_first_turn lands in one, the tool steps + assemble in
    # another, and the published envelope loses its summary/model (mono #1404).
    return session_id or task_id or "default"


def _key(
    task_id: str,
    session_id: str,
    lifecycle_token: object | None = None,
) -> object:
    session_key = _session_key(task_id, session_id)
    if lifecycle_token is None:
        return session_key
    return (session_key, lifecycle_token)


def _fresh_buffer(session_id: str, key: str) -> Dict[str, Any]:
    return {
        "sessionId": session_id or key,
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "startedNs": time.time_ns(),
        "steps": [],
        # Ordered agent-turn spans (user/assistant) for the EpisodeV1 trajectory.
        # Kept OUT of "steps" so the legacy CapturedTask tee stays byte-identical
        # (its steps are tool calls only). appendIndex preserves emit order for a
        # stable timestamp-tie merge with tool steps (mono #1662).
        "turns": [],
        "tools": set(),
    }


def record_first_turn(
    task_id: str,
    session_id: str,
    user_message: str,
    model: str,
    platform: str = "",
    *,
    lifecycle_token: object | None = None,
) -> None:
    key = _key(task_id, session_id, lifecycle_token)
    with _lock:
        buf = _buffers.setdefault(
            key,
            _fresh_buffer(
                session_id,
                _session_key(task_id, session_id),
            ),
        )
        # Guard an empty/whitespace first message: "".splitlines()[0] raises
        # IndexError, which — swallowed by the hook dispatcher — would skip the
        # model write below and strand the trace without metadata (mono #1404).
        lines = (user_message or "").strip().splitlines()
        if lines and lines[0].strip():
            buf.setdefault("summary", lines[0][:500])
        buf["model"] = model or buf.get("model", "")
        buf["platform"] = platform or buf.get("platform", "")


def record_tool_call(
    task_id: str,
    session_id: str,
    tool_name: str,
    tool_call_id: str,
    args: Any,
    result: Any,
    duration_ms: Optional[int] = None,
    *,
    lifecycle_token: object | None = None,
) -> None:
    key = _key(task_id, session_id, lifecycle_token)
    end_ns = time.time_ns()
    start_ns = end_ns - int((duration_ms or 0) * 1_000_000)
    with _lock:
        buf = _buffers.setdefault(
            key,
            {
                "sessionId": session_id or _session_key(task_id, session_id),
                "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "startedNs": start_ns,
                "steps": [],
                "tools": set(),
            },
        )
        buf["tools"].add(tool_name)
        buf["steps"].append(
            {
                "spanId": tool_call_id or f"step-{len(buf['steps']) + 1}",
                "parentSpanId": None,
                "name": f"tool:{tool_name}",
                "startTimeUnixNano": str(start_ns),
                "endTimeUnixNano": str(end_ns),
                # Raw here; scrubbed fail-closed inside jinn-layer before
                # anything can publish.
                "attributes": {"tool.args": args, "tool.result": result},
                "redactedKeys": [],
            }
        )


def _record_turn(
    task_id: str,
    session_id: str,
    role: str,
    text: str,
    *,
    lifecycle_token: object | None = None,
) -> None:
    """Append an ordered agent-turn span (user or assistant) into the buffer.

    Legacy steps carry no ``kind`` — the ``jinn.agent_turn`` discriminator is
    applied only when the EpisodeV1 shape is built (assemble_episode). The span
    lands in the same ``steps`` list as tool calls so append order preserves the
    per-turn interleaving user → tool* → assistant.
    """
    key = _key(task_id, session_id, lifecycle_token)
    now_ns = time.time_ns()
    with _lock:
        buf = _buffers.setdefault(
            key,
            _fresh_buffer(
                session_id,
                _session_key(task_id, session_id),
            ),
        )
        turns = buf.setdefault("turns", [])
        turns.append(
            {
                "spanId": f"turn-{len(turns) + 1}",
                "parentSpanId": None,
                "name": f"turn:{role}",
                "startTimeUnixNano": str(now_ns),
                "endTimeUnixNano": str(now_ns),
                # Raw here; scrubbed fail-closed inside jinn-layer before publish.
                "attributes": {"turn.text": text, "role": role},
                "redactedKeys": [],
            }
        )


def record_user_turn(
    task_id: str,
    session_id: str,
    user_message: str,
    *,
    lifecycle_token: object | None = None,
) -> None:
    _record_turn(
        task_id,
        session_id,
        "user",
        user_message,
        lifecycle_token=lifecycle_token,
    )


def record_assistant_turn(
    task_id: str,
    session_id: str,
    assistant_response: str,
    *,
    lifecycle_token: object | None = None,
) -> None:
    _record_turn(
        task_id,
        session_id,
        "assistant",
        assistant_response,
        lifecycle_token=lifecycle_token,
    )


def record_environment(
    task_id: str,
    session_id: str,
    skills_loadout: List[str],
    *,
    lifecycle_token: object | None = None,
) -> None:
    key = _key(task_id, session_id, lifecycle_token)
    with _lock:
        buf = _buffers.setdefault(
            key,
            _fresh_buffer(
                session_id,
                _session_key(task_id, session_id),
            ),
        )
        buf.setdefault("skillsLoadout", list(skills_loadout or []))


def record_tokens(
    task_id: str,
    session_id: str,
    input: int,
    output: int,
    *,
    lifecycle_token: object | None = None,
) -> None:
    key = _key(task_id, session_id, lifecycle_token)
    with _lock:
        buf = _buffers.setdefault(
            key,
            _fresh_buffer(
                session_id,
                _session_key(task_id, session_id),
            ),
        )
        buf["tokens"] = {"input": int(input), "output": int(output)}


def has_steps(
    task_id: str,
    session_id: str,
    *,
    lifecycle_token: object | None = None,
) -> bool:
    with _lock:
        buf = _buffers.get(
            _key(task_id, session_id, lifecycle_token)
        )
        return bool(buf and buf["steps"])


def has_capture(
    task_id: str,
    session_id: str,
    *,
    lifecycle_token: object | None = None,
) -> bool:
    """Whether any ordinary agent activity is currently captured locally."""
    with _lock:
        buf = _buffers.get(
            _key(task_id, session_id, lifecycle_token)
        )
        return bool(buf and (buf["steps"] or buf.get("turns")))


def discard(
    task_id: str,
    session_id: str,
    *,
    lifecycle_token: object | None = None,
) -> None:
    """Drop unfinished capture at a host session-finalize boundary."""
    with _lock:
        _buffers.pop(
            _key(task_id, session_id, lifecycle_token),
            None,
        )


def discard_session(
    session_id: str,
    *,
    lifecycle_token: object = _ALL_LIFECYCLES,
    include_legacy: bool = False,
) -> None:
    """Drop capture owned by one lifecycle, or every lifecycle for legacy callers.

    Passing ``lifecycle_token`` targets only that token-owned buffer. The
    optional tokenless legacy entry is a separate exact key, so cleanup for a
    closed lifecycle can never delete a freshly reopened token-owned buffer.
    Omitting the token preserves the standalone legacy API's session-wide
    behavior.
    """
    session_key = _session_key("", session_id)
    with _lock:
        if lifecycle_token is not _ALL_LIFECYCLES:
            _buffers.pop(
                _key("", session_id, lifecycle_token),
                None,
            )
            if include_legacy:
                _buffers.pop(session_key, None)
            return
        for key in list(_buffers):
            key_session = key[0] if isinstance(key, tuple) else key
            if key_session == session_key:
                _buffers.pop(key, None)


def _pop(
    task_id: str,
    session_id: str,
    lifecycle_token: object | None = None,
) -> Optional[Dict[str, Any]]:
    """Pop the buffer once (None if absent or wholly empty).

    "Wholly empty" = no tool steps AND no turn spans. A turn-only session (no
    tool calls) still yields a buffer so an EpisodeV1 can carry its ≥1 agent
    turn; the legacy assemble() re-checks steps and returns None for it.
    """
    with _lock:
        buf = _buffers.pop(
            _key(task_id, session_id, lifecycle_token),
            None,
        )
    if not buf or (not buf["steps"] and not buf.get("turns")):
        return None
    return buf


def _status(completed: bool, interrupted: bool) -> str:
    return "completed" if (completed and not interrupted) else ("abandoned" if interrupted else "failed")


def _build_legacy(buf: Dict[str, Any], completed: bool, interrupted: bool) -> Dict[str, Any]:
    status = _status(completed, interrupted)
    duration_ms = max(0, (time.time_ns() - int(buf["startedNs"])) // 1_000_000)
    h_name, h_version = _harness.harness()
    tags = [h_name]
    if buf.get("platform"):
        tags.append(str(buf["platform"]))

    return {
        "session": {
            "sessionId": str(buf["sessionId"])[:128],
            "capturedAt": buf["capturedAt"],
        },
        "task": {
            "summary": buf.get("summary") or "(no summary)",
            "distributionTags": tags,
        },
        "environment": {
            "harness": {"name": h_name, "version": h_version},
            "model": buf.get("model") or "unknown",
            "tools": sorted(buf["tools"]),
        },
        "steps": buf["steps"],
        "outcome": {
            "status": status,
            # user-accepted is the honest v0 tier: the operator ran the task;
            # no automated check attests the outcome.
            "verifiabilityTier": "user-accepted",
        },
        "cost": {"durationMs": int(duration_ms)},
        "provenance": "contributed",
    }


def _episode_step(step: Dict[str, Any]) -> Dict[str, Any]:
    """Map a legacy buffer step to a kind-tagged EpisodeV1 Step."""
    role = step.get("attributes", {}).get("role")
    kind = "jinn.agent_turn" if role in ("user", "assistant") else "jinn.tool_call"
    return {
        "spanId": step["spanId"],
        "parentSpanId": step["parentSpanId"],
        "kind": kind,
        "name": step["name"],
        "startTimeUnixNano": step["startTimeUnixNano"],
        "endTimeUnixNano": step["endTimeUnixNano"],
        "attributes": step["attributes"],
        "redactedKeys": step.get("redactedKeys", []),
    }


def _build_episode(
    buf: Dict[str, Any],
    completed: bool,
    interrupted: bool,
    publish_consented: bool,
) -> Dict[str, Any]:
    status = _status(completed, interrupted)
    duration_ms = max(0, (time.time_ns() - int(buf["startedNs"])) // 1_000_000)
    h_name, h_version = _harness.harness()
    session_id = str(buf["sessionId"])[:128]

    cost: Dict[str, Any] = {"durationMs": int(duration_ms)}
    tokens = buf.get("tokens")
    if tokens:
        cost["tokens"] = {"input": int(tokens["input"]), "output": int(tokens["output"])}

    # Merge the ordered turn spans with the tool-call steps by end-time nanos.
    # Both are stamped with time.time_ns() at their record moment, which is
    # strictly increasing in emission order (user → tool* → assistant), so this
    # reconstructs the per-turn interleaving without mutating the legacy steps.
    merged = sorted(
        buf.get("turns", []) + buf["steps"],
        key=lambda s: int(s["endTimeUnixNano"]),
    )

    return {
        "schemaVersion": "jinn.episode.v1",
        "episodeId": f"{session_id}-{int(buf['startedNs'])}",
        "session": {
            "sessionId": session_id,
            "capturedAt": buf["capturedAt"],
            "kind": "user",
        },
        "origin": {"writer": h_name, "build": h_version},
        "task": {
            "summary": buf.get("summary") or "(no summary)",
            "distributionTags": [],
        },
        "trajectory": [_episode_step(s) for s in merged],
        "environment": {
            "harness": {"name": h_name, "version": h_version},
            "model": buf.get("model") or "unknown",
            "tools": sorted(buf["tools"]),
            "skillsLoadout": list(buf.get("skillsLoadout", [])),
        },
        "outcome": {
            "status": status,
            "verificationStrength": "user-accepted",
        },
        "cost": cost,
        "retention": {
            "policy": "contribution-eligible" if publish_consented else "local-private",
        },
        "provenance": "contributed",
    }


def assemble(
    task_id: str,
    session_id: str,
    completed: bool,
    interrupted: bool,
    *,
    lifecycle_token: object | None = None,
) -> Optional[Dict[str, Any]]:
    """Pop the buffer and return the CapturedTask dict (None if empty)."""
    buf = _pop(task_id, session_id, lifecycle_token)
    if buf is None or not buf["steps"]:
        return None
    return _build_legacy(buf, completed, interrupted)


def assemble_episode(
    task_id: str,
    session_id: str,
    completed: bool,
    interrupted: bool,
    publish_consented: bool = False,
    *,
    lifecycle_token: object | None = None,
) -> Optional[Dict[str, Any]]:
    """Pop the buffer and return the EpisodeV1 dict (None if empty)."""
    buf = _pop(task_id, session_id, lifecycle_token)
    return assemble_claimed_episode(
        buf,
        completed,
        interrupted,
        publish_consented,
    )


def claim_episode_inputs(
    task_id: str,
    session_id: str,
    *,
    lifecycle_token: object | None = None,
) -> Optional[Dict[str, Any]]:
    """Detach one exact-generation buffer for an admitted completion."""
    return _pop(
        task_id,
        session_id,
        lifecycle_token,
    )


def assemble_claimed_episode(
    claimed: Optional[Dict[str, Any]],
    completed: bool,
    interrupted: bool,
    publish_consented: bool = False,
    *,
    skills_loadout: Optional[List[str]] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Build an episode from inputs detached at completion admission."""
    if claimed is None:
        return None
    if skills_loadout is not None:
        claimed.setdefault(
            "skillsLoadout",
            list(skills_loadout),
        )
    if input_tokens or output_tokens:
        claimed["tokens"] = {
            "input": int(input_tokens or 0),
            "output": int(output_tokens or 0),
        }
    return _build_episode(
        claimed,
        completed,
        interrupted,
        publish_consented,
    )


def assemble_both(
    task_id: str,
    session_id: str,
    completed: bool,
    interrupted: bool,
    publish_consented: bool = False,
    *,
    lifecycle_token: object | None = None,
) -> tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Pop the buffer ONCE and return (legacy CapturedTask, EpisodeV1).

    The session-end path needs both shapes from the identical buffer snapshot;
    ``assemble()`` pops, so calling it twice would strand the second read.
    Both are ``None`` when the buffer is empty.
    """
    buf = _pop(task_id, session_id, lifecycle_token)
    if buf is None:
        return None, None
    legacy = _build_legacy(buf, completed, interrupted) if buf["steps"] else None
    return (
        legacy,
        _build_episode(buf, completed, interrupted, publish_consented),
    )


def reset() -> None:
    """Test helper — drop all buffers."""
    with _lock:
        _buffers.clear()
