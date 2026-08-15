"""Write the session feed the runtime seals.

This is the bulk-bytes-by-path half of the host seam: transcript content is
appended here and the runtime is handed only a path. Two invariants a reader
depends on, held here because only the writer can hold them:

* ``atUnixNano`` never decreases. A trajectory needs a monotonic order, and a
  wall clock does not provide one (NTP steps, suspend/resume).
* Lines are appended and never reordered or rewritten. A span back-references a
  feed line by its zero-based ordinal, so mutating a line silently rewrites
  history that has already been sealed elsewhere.

Nothing here raises into a host hook. A capture problem must never break the
user's session.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

FEED_VERSION = 1

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def stringify(value: Any) -> str:
    """Pre-stringify a structured value, per C4's feed contract.

    Sorted keys so two structurally equal arguments produce identical bytes,
    which is what lets a decoder's determinism fixtures mean anything.
    """
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=repr)
    except (TypeError, ValueError):
        return repr(value)


class SessionFeed:
    """An append-only NDJSON writer for one capture session."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._lock = threading.Lock()
        self._last_ns = 0
        self.line_count = 0

    @property
    def path(self) -> Path:
        return self._path

    # -- events ------------------------------------------------------------

    def open_session(
        self,
        session_id: str,
        host_name: str,
        host_version: str,
        model_provider: str,
        model_name: str,
        conversation_id: Optional[str] = None,
    ) -> None:
        event = {
            "type": "session-open",
            "v": FEED_VERSION,
            "sessionId": session_id,
            "startedAt": _now_iso(),
            "host": {"name": host_name, "version": host_version},
            "model": {"provider": model_provider, "name": model_name},
        }
        if conversation_id:
            event["conversationId"] = conversation_id
        self._append(event)

    def environment(self, tools: Sequence[str], skills: Sequence[str]) -> None:
        self._append({"type": "environment", "tools": list(tools), "skills": list(skills)})

    def user_turn(self, text: str) -> None:
        self._append({"type": "user-turn", "text": text})

    def assistant_turn(self, text: str, model: Optional[str] = None) -> None:
        event = {"type": "assistant-turn", "text": text}
        if model:
            event["model"] = model
        self._append(event)

    def tool_call(
        self,
        tool_name: str,
        tool_call_id: str,
        arguments: Any,
        result: Any,
        status: str,
        started_at_unix_nano: Optional[int],
        error_message: Optional[str] = None,
    ) -> None:
        event = {
            "type": "tool-call",
            "toolName": tool_name,
            "toolCallId": tool_call_id,
            "status": "error" if status == "error" else "ok",
            "arguments": stringify(arguments),
            "result": stringify(result),
        }
        if error_message:
            event["errorMessage"] = error_message
        self._append(event, started_at_unix_nano=started_at_unix_nano)

    def tokens(self, input_tokens: int, output_tokens: int) -> None:
        self._append(
            {
                "type": "tokens",
                "inputTokens": int(input_tokens),
                "outputTokens": int(output_tokens),
            }
        )

    def close_session(self, outcome: str, summary: str) -> None:
        self._append(
            {
                "type": "session-close",
                "endedAt": _now_iso(),
                "outcome": outcome,
                "summary": summary,
            }
        )

    # -- internals ---------------------------------------------------------

    def _append(self, event: dict, started_at_unix_nano: Optional[int] = None) -> None:
        with self._lock:
            stamp = max(time.time_ns(), self._last_ns)
            self._last_ns = stamp
            event["atUnixNano"] = str(stamp)
            if started_at_unix_nano is not None:
                event["startedAtUnixNano"] = str(min(started_at_unix_nano, stamp))
            elif event.get("type") == "tool-call":
                event["startedAtUnixNano"] = str(stamp)
            line = json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n"
            try:
                # Append mode with one write per line: the OS keeps a single
                # write under PIPE_BUF atomic, so concurrent hook threads never
                # tear a line. The mode is never touched; the runtime created
                # the file 0600 and owns that decision.
                with self._path.open("a", encoding="utf-8") as handle:
                    handle.write(line)
                    handle.flush()
            except OSError as exc:
                logger.debug("jinn: session feed write failed: %s", exc)
                return
            self.line_count += 1
