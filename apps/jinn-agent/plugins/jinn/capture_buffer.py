"""Per-task capture buffer — assembles a CapturedTask for the Jinn layer.

The plugin records the first user message (``pre_llm_call``) and every tool
call (``post_tool_call``) into an in-memory buffer keyed by task/session,
then assembles the ``CapturedTask`` JSON that ``jinn-layer`` consumes
(``client/packages/harness-layer/src/capture.ts`` ``CapturedTaskSchema`` in
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
_buffers: Dict[str, Dict[str, Any]] = {}


def _key(task_id: str, session_id: str) -> str:
    # Key on the session, which is stable for the whole conversation. task_id is
    # a fresh per-turn uuid on the interactive path (the agent mints one when no
    # explicit task is set), so keying on it fragments a session's trace across
    # buffers — record_first_turn lands in one, the tool steps + assemble in
    # another, and the published envelope loses its summary/model (mono #1404).
    return session_id or task_id or "default"


def _now_nano() -> str:
    return str(time.time_ns())


def record_first_turn(
    task_id: str,
    session_id: str,
    user_message: str,
    model: str,
    platform: str = "",
) -> None:
    key = _key(task_id, session_id)
    with _lock:
        buf = _buffers.setdefault(
            key,
            {
                "sessionId": session_id or key,
                "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "startedNs": time.time_ns(),
                "steps": [],
                "tools": set(),
            },
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
) -> None:
    key = _key(task_id, session_id)
    end_ns = time.time_ns()
    start_ns = end_ns - int((duration_ms or 0) * 1_000_000)
    with _lock:
        buf = _buffers.setdefault(
            key,
            {
                "sessionId": session_id or key,
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


def has_steps(task_id: str, session_id: str) -> bool:
    with _lock:
        buf = _buffers.get(_key(task_id, session_id))
        return bool(buf and buf["steps"])


def assemble(
    task_id: str,
    session_id: str,
    completed: bool,
    interrupted: bool,
) -> Optional[Dict[str, Any]]:
    """Pop the buffer and return the CapturedTask dict (None if empty)."""
    with _lock:
        buf = _buffers.pop(_key(task_id, session_id), None)
    if not buf or not buf["steps"]:
        return None

    status = "completed" if (completed and not interrupted) else ("abandoned" if interrupted else "failed")
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


def reset() -> None:
    """Test helper — drop all buffers."""
    with _lock:
        _buffers.clear()
