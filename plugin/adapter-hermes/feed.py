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

import base64
import json
import logging
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

FEED_VERSION = 1

#: Bounds the runtime enforces on ``controlled-input``. Held here too so an oversized input is
#: dropped rather than refusing the whole capture at seal time.
CONTROLLED_INPUT_MAX_BYTES = 256 * 1024
CONTROLLED_INPUT_MAX_COUNT = 32

CONTROLLED_INPUT_ROLES = ("workflow", "skill", "prompt", "config")

#: The service IRI namespace the runtime's fixture already fixed. Deriving one here is what lets
#: a hosted model be recorded as a deployment identity rather than a bare label.
MODEL_SERVICE_IRI_PREFIX = "https://spec.jinn.network/services"

_GIT_OBJECT_NAME = re.compile(r"\A(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
#: Matches the runtime's `isAbsoluteIri`, which rejects whitespace anywhere — not merely
#: immediately after the scheme. A laxer check here writes a feed the runtime refuses whole.
_ABSOLUTE_IRI = re.compile(r"\A[A-Za-z][A-Za-z0-9+.\-]*:\S+\Z")
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def _slug(value: str) -> str:
    return _SLUG_STRIP.sub("-", value.lower()).strip("-")


def derive_model_service(provider: str, model_name: str, version: str = "") -> Optional[dict]:
    """Build the hosted model's service identity from what the host already knows.

    Returns ``None`` when neither part slugs to anything, because an identity that says nothing
    is worse than an absent one — the record would assert a deployment it cannot name.
    """
    provider_slug, model_slug = _slug(provider), _slug(model_name)
    if not provider_slug or not model_slug:
        return None
    service = {
        "iri": f"{MODEL_SERVICE_IRI_PREFIX}/{provider_slug}/{model_slug}",
        "name": f"{provider} {model_name}",
    }
    if version:
        service["version"] = version
    return service


def _blank(value: Any) -> bool:
    return not isinstance(value, str) or not value.strip()

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
        self._controlled_inputs = 0
        self._repository_state_written = False

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
        model_service: Optional[Mapping[str, str]] = None,
    ) -> None:
        model: dict = {"provider": model_provider, "name": model_name}
        if isinstance(model_service, Mapping) and model_service:
            # The hosted model's deployment identity, which the record carries as an opaque
            # runtime component. A producer cannot content-address a hosted service, so this
            # identity is what stands in for one.
            service = {
                key: value.strip()
                for key, value in model_service.items()
                if key in ("iri", "name", "version", "deployment", "providerIri")
                and not _blank(value)
            }
            # Without a well-formed IRI the runtime refuses the whole feed, so drop the identity
            # rather than the session. Same for a service that names itself as its own provider.
            if _ABSOLUTE_IRI.match(service.get("iri", "")) and service.get(
                "providerIri"
            ) != service.get("iri"):
                model["service"] = service
            else:
                logger.debug("jinn: unusable model service identity %r", model_service)
        event = {
            "type": "session-open",
            "v": FEED_VERSION,
            "sessionId": session_id,
            "startedAt": _now_iso(),
            "host": {"name": host_name, "version": host_version},
            "model": model,
        }
        if conversation_id:
            event["conversationId"] = conversation_id
        self._append(event)

    def repository_state(
        self,
        repository: str,
        base_commit: str,
        base_tree: str,
        branch: str = "",
        target_base: str = "",
    ) -> None:
        """Report the base repository state this session starts from.

        Emitted once, before the first turn. The commit and tree object names are the content
        binding a verifier resolves; without them the sealed record cannot say what the work
        started from. Branch and target base are context and may be unknown.

        Validated and skipped rather than written when it would be refused: the runtime rejects
        a malformed feed whole, so one bad event here would cost every event in the session.
        """
        if not _ABSOLUTE_IRI.match(repository or ""):
            logger.debug("jinn: repository %r is not an absolute IRI", repository)
            return
        for name, value in (("baseCommit", base_commit), ("baseTree", base_tree)):
            if not _GIT_OBJECT_NAME.match(value or ""):
                logger.debug("jinn: %s %r is not a Git object name", name, value)
                return
        with self._lock:
            if self._repository_state_written:
                logger.debug("jinn: repository state already reported")
                return
            self._repository_state_written = True
        event = {
            "type": "repository-state",
            "repository": repository,
            "baseCommit": base_commit,
            "baseTree": base_tree,
        }
        # A detached head reports the branch as "HEAD", which names nothing; omit it instead.
        if not _blank(branch) and branch.strip() != "HEAD":
            event["branch"] = branch.strip()
        if not _blank(target_base):
            event["targetBase"] = target_base.strip()
        self._append(event)

    def controlled_input(
        self,
        role: str,
        name: str,
        media_type: str,
        content: bytes,
    ) -> None:
        """Bind the exact bytes of one producer-controlled input.

        Bytes travel inline rather than by path, matching the runtime's contract. The caller
        assembles ``content`` without credentials: the runtime binds what it is given and does
        not scrub, so segregation happens here, at the source.

        Silently skipped when the input would be refused, because a capture problem must never
        break the session — and a refused feed loses every event, not just this one.
        """
        if role not in CONTROLLED_INPUT_ROLES:
            logger.debug("jinn: unknown controlled-input role %r", role)
            return
        if _blank(name) or _blank(media_type):
            logger.debug("jinn: controlled input %r has a blank name or media type", name)
            return
        # Encode before the budget is spent, and before anything is written: a caller that hands
        # us text instead of bytes must cost one dropped input, never an exception in a host hook.
        try:
            encoded = base64.b64encode(content).decode("ascii")
        except (TypeError, ValueError) as exc:
            logger.debug("jinn: controlled input %r is not bindable bytes: %s", name, exc)
            return
        if not content or len(content) > CONTROLLED_INPUT_MAX_BYTES:
            logger.debug("jinn: controlled input %r has an unbindable size", name)
            return
        with self._lock:
            if self._controlled_inputs >= CONTROLLED_INPUT_MAX_COUNT:
                logger.debug("jinn: controlled-input budget spent, dropping %r", name)
                return
            self._controlled_inputs += 1
        self._append(
            {
                "type": "controlled-input",
                "role": role,
                "name": name,
                "mediaType": media_type,
                "contentBase64": encoded,
            }
        )

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
