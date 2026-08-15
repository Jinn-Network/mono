"""jinn plugin — the Jinn-Hermes fork's single integration surface.

The plugin captures local session evidence unconditionally, assembles one
complete EpisodeV1, and delegates it through the versioned ``jinn-layer
session end`` process bridge.  The core owns canonical persistence,
eligibility, contribution recording/veto, and summaries.  A bridge failure
falls back to one local EpisodeV1 write; the retired raw pending/publication
queue is never created or drained here.

Outbound contribution is parked for Stage 2. Retained Stage 1 consent state
is ignored; local capture, candidate recording, mining, and distillation stay
live. Automatic pickup is the only corpus-consumption path; ``/jinn`` exposes
status, session, history, veto, and distill.

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
from contextvars import ContextVar
from dataclasses import dataclass
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
_completion_condition = threading.Condition(_session_state_lock)
_session_states: Dict[str, Dict[str, Any]] = {}
_session_lifecycle_tokens: Dict[str, object] = {}
_session_state_tokens: Dict[str, object] = {}
_completion_leases: Dict[_SessionLifecycleToken, int] = {}
# Originating turn ownership for asynchronous post-hook callbacks. Keys use
# the host session id because host-internal logical ids are plugin-owned and
# must not be recreated merely to resolve a delayed callback.
_session_turn_lifecycle_owners: Dict[
    tuple[str, str],
    _TurnLifecycleOwner,
] = {}
# Pickup exclusions/checkpoints span run_conversation turns and are cleared
# only at the host's real session-finalize boundary.
_pickup_checkpoints: Dict[str, Dict[str, Any]] = {}
_internal_session_lock = threading.Lock()
_internal_sessions: Dict[tuple[str, int], str] = {}
_internal_session_parent_tokens: Dict[
    tuple[str, int],
    _SessionLifecycleToken,
] = {}
_internal_session_lifecycle_tokens: Dict[
    tuple[str, int],
    _SessionLifecycleToken,
] = {}


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
        closed_lifecycles = list(
            _session_lifecycle_tokens.items()
        )
        _session_states.clear()
        _session_lifecycle_tokens.clear()
        _session_state_tokens.clear()
        _completion_leases.clear()
        _session_turn_lifecycle_owners.clear()
        _pickup_checkpoints.clear()
        _completion_condition.notify_all()
    with _internal_session_lock:
        _internal_sessions.clear()
        _internal_session_parent_tokens.clear()
        _internal_session_lifecycle_tokens.clear()
    _foreground_parent_lifecycle.set(None)
    for session_id, lifecycle_token in closed_lifecycles:
        buf.discard_session(
            session_id,
            lifecycle_token=lifecycle_token,
            include_legacy=True,
        )


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


def _clear_veto(
    session_id: str,
    *,
    expected_token: Optional[_SessionLifecycleToken] = None,
    allow_closed_lifecycle: bool = False,
) -> None:
    with _session_state_lock:
        current_token = _session_lifecycle_tokens.get(
            session_id or "default"
        )
        if (
            expected_token is not None
            and current_token is not expected_token
            and not (
                allow_closed_lifecycle
                and current_token is None
            )
        ):
            return
        try:
            _veto_path(session_id).unlink(missing_ok=True)
        except OSError:
            return
        with _veto_lock:
            _vetoed_tasks.discard(session_id)


def _empty_activity() -> Dict[str, Any]:
    """Evidence-first pickup facts plus legacy read-compatible activity fields.

    ``surfacedRefs``/``fetchedRefs``/``installedSkillRefs`` remain present so
    older episodes retain their schema shape; automatic pickup records current
    delivery through ``searchedTerms``/``providedRefs``.
    """
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


def _empty_pickup_checkpoint() -> Dict[str, Any]:
    """Host control state for task/repository-scoped corpus delivery."""
    return {
        "hasRun": False,
        "taskId": None,
        "repositorySlug": None,
        "repositoryCwd": None,
        "deliveredCanonicalEpisodeIds": [],
    }


@dataclass(frozen=True)
class _PickupRepositoryIdentity:
    repository_slug: Optional[str]
    repository_cwd: Optional[str]
    verified: bool


class _SessionLifecycleToken:
    """Opaque identity for one active host session lifetime."""


@dataclass(frozen=True)
class _ParentLifecycleIdentity:
    """Foreground lifecycle generation inherited by a review thread."""

    session_id: str
    lifecycle_token: _SessionLifecycleToken


_foreground_parent_lifecycle: ContextVar[
    Optional[_ParentLifecycleIdentity]
] = ContextVar(
    "jinn_foreground_parent_lifecycle",
    default=None,
)


_STABLE_TASK_ID_UNSET = object()


@dataclass(frozen=True)
class _TurnLifecycleOwner:
    """Logical session lifecycle that originated one host turn."""

    logical_session_id: str
    lifecycle_token: _SessionLifecycleToken


@dataclass(frozen=True)
class _CompletionFence:
    """Lifecycle identity allowed to publish post-pop completion effects."""

    logical_session_id: str
    lifecycle_token: _SessionLifecycleToken
    parent_session_id: Optional[str] = None


@dataclass(frozen=True)
class _CompletionLease:
    """One admitted completion and its detached generation-owned inputs."""

    fence: _CompletionFence
    state: Dict[str, Any]
    episode_inputs: Optional[Dict[str, Any]]


@dataclass(frozen=True)
class _PickupReservation:
    excluded_canonical_episode_ids: tuple[str, ...]
    token: _SessionLifecycleToken


def _session_identity(
    session_id: str,
) -> Optional[
    tuple[
        str,
        str,
        Optional[str],
        _SessionLifecycleToken,
    ]
]:
    """Separate host-internal review evidence from its foreground parent."""
    parent = session_id or "default"
    if not is_background_review():
        lifecycle_token = _session_lifecycle_token(parent)
        _foreground_parent_lifecycle.set(
            _ParentLifecycleIdentity(
                session_id=parent,
                lifecycle_token=lifecycle_token,
            )
        )
        return parent, "user", None, lifecycle_token

    parent_identity = _foreground_parent_lifecycle.get()
    if (
        parent_identity is None
        or parent_identity.session_id != parent
    ):
        return None
    thread_id = threading.get_ident()
    key = (parent, thread_id)
    with _session_state_lock:
        if (
            _session_lifecycle_tokens.get(parent)
            is not parent_identity.lifecycle_token
        ):
            return None
        with _internal_session_lock:
            logical = _internal_sessions.get(key)
            if (
                logical is None
                or _internal_session_parent_tokens.get(key)
                is not parent_identity.lifecycle_token
            ):
                suffix = hashlib.sha256(
                    f"{parent}:{thread_id}:{time.time_ns()}".encode("utf-8")
                ).hexdigest()[:16]
                logical = f"{parent[:96]}-host-internal-{suffix}"[:128]
                _internal_sessions[key] = logical
                _internal_session_parent_tokens[key] = (
                    parent_identity.lifecycle_token
                )
            lifecycle_token = _session_lifecycle_tokens.get(logical)
            if not isinstance(
                lifecycle_token,
                _SessionLifecycleToken,
            ):
                lifecycle_token = _SessionLifecycleToken()
                _session_lifecycle_tokens[logical] = lifecycle_token
            _internal_session_lifecycle_tokens[key] = (
                lifecycle_token
            )
    return (
        logical,
        "host-internal",
        parent[:128],
        lifecycle_token,
    )


def _release_internal_session(
    parent_session_id: Optional[str],
    *,
    expected_logical_session_id: Optional[str] = None,
    expected_parent_token: Optional[_SessionLifecycleToken] = None,
) -> None:
    if parent_session_id is None:
        return
    with _internal_session_lock:
        key = (parent_session_id, threading.get_ident())
        if (
            expected_logical_session_id is not None
            and _internal_sessions.get(key)
            != expected_logical_session_id
        ):
            return
        if (
            expected_parent_token is not None
            and _internal_session_parent_tokens.get(key)
            is not expected_parent_token
        ):
            return
        _internal_sessions.pop(key, None)
        _internal_session_parent_tokens.pop(key, None)
        _internal_session_lifecycle_tokens.pop(key, None)


def _release_all_internal_sessions(
    parent_session_id: str,
    *,
    expected_parent_token: Optional[_SessionLifecycleToken] = None,
) -> list[str]:
    with _internal_session_lock:
        keys = [
            key
            for key in _internal_sessions
            if (
                key[0] == parent_session_id
                and (
                    expected_parent_token is None
                    or _internal_session_parent_tokens.get(key)
                    is expected_parent_token
                )
            )
        ]
        logical_session_ids = [
            _internal_sessions.pop(key)
            for key in keys
        ]
        for key in keys:
            _internal_session_parent_tokens.pop(key, None)
            _internal_session_lifecycle_tokens.pop(key, None)
    return logical_session_ids


def _internal_sessions_for_parent(
    parent_session_id: str,
    parent_token: Optional[_SessionLifecycleToken],
) -> list[tuple[str, _SessionLifecycleToken]]:
    """Snapshot exact-generation child ownership without releasing it."""
    if parent_token is None:
        return []
    with _internal_session_lock:
        return [
            (
                logical_session_id,
                child_token,
            )
            for key, logical_session_id in _internal_sessions.items()
            if isinstance(
                child_token := (
                    _internal_session_lifecycle_tokens.get(key)
                ),
                _SessionLifecycleToken,
            )
            if (
                key[0] == parent_session_id
                and (
                    parent_token is None
                    or _internal_session_parent_tokens.get(key)
                    is parent_token
                )
            )
        ]


def _session_lifecycle_token(
    logical_session_id: str,
) -> _SessionLifecycleToken:
    key = logical_session_id or "default"
    with _session_state_lock:
        token = _session_lifecycle_tokens.get(key)
        if token is None:
            token = _SessionLifecycleToken()
            _session_lifecycle_tokens[key] = token
        return token


def _current_session_lifecycle_token(
    logical_session_id: str,
) -> Optional[_SessionLifecycleToken]:
    key = logical_session_id or "default"
    with _session_state_lock:
        token = _session_lifecycle_tokens.get(key)
        return token if isinstance(token, _SessionLifecycleToken) else None


def _bind_session_turn_lifecycle(
    session_id: str,
    turn_id: str,
    logical_session_id: str,
    lifecycle_token: _SessionLifecycleToken,
) -> bool:
    """Bind a real host turn to the lifecycle opened by its pre hook."""
    logical_key = logical_session_id or "default"
    host_key = session_id or "default"
    with _session_state_lock:
        if _session_lifecycle_tokens.get(logical_key) is not lifecycle_token:
            return False
        if turn_id:
            _session_turn_lifecycle_owners[(host_key, turn_id)] = (
                _TurnLifecycleOwner(
                    logical_session_id=logical_key,
                    lifecycle_token=lifecycle_token,
                )
            )
        return True


def _active_logical_session_id(session_id: str) -> Optional[str]:
    """Resolve the current logical id without creating internal ownership."""
    parent = session_id or "default"
    if not is_background_review():
        return parent
    with _internal_session_lock:
        return _internal_sessions.get(
            (parent, threading.get_ident())
        )


def _post_hook_lifecycle(
    session_id: str,
    turn_id: str,
) -> Optional[_TurnLifecycleOwner]:
    """Resolve post-hook ownership without opening a lifecycle.

    Real host callbacks carry ``turn_id`` and must match the lifecycle bound
    by their pre hook. Legacy/direct callbacks without a turn id may observe
    an already-active lifecycle, but can never create one.
    """
    host_key = session_id or "default"
    if turn_id:
        with _session_state_lock:
            owner = _session_turn_lifecycle_owners.get(
                (host_key, turn_id)
            )
            if (
                owner is None
                or _session_lifecycle_tokens.get(
                    owner.logical_session_id
                ) is not owner.lifecycle_token
            ):
                return None
            return owner

    logical_session_id = _active_logical_session_id(session_id)
    if logical_session_id is None:
        return None
    with _session_state_lock:
        lifecycle_token = _session_lifecycle_tokens.get(
            logical_session_id
        )
        if not isinstance(
            lifecycle_token,
            _SessionLifecycleToken,
        ):
            return None
        return _TurnLifecycleOwner(
            logical_session_id=logical_session_id,
            lifecycle_token=lifecycle_token,
        )


def _release_session_turn_lifecycle(
    session_id: str,
    turn_id: str,
    *,
    expected_token: Optional[_SessionLifecycleToken] = None,
) -> None:
    """Release exact turn ownership at its run-conversation boundary."""
    if not turn_id:
        return
    with _session_state_lock:
        key = (session_id or "default", turn_id)
        owner = _session_turn_lifecycle_owners.get(key)
        if (
            expected_token is not None
            and (
                owner is None
                or owner.lifecycle_token is not expected_token
            )
        ):
            return
        _session_turn_lifecycle_owners.pop(
            key,
            None,
        )


def _discard_turn_lifecycle_owners_locked(
    logical_session_id: str,
) -> None:
    """Drop every turn binding owned by one closing logical lifecycle."""
    for key, owner in list(
        _session_turn_lifecycle_owners.items()
    ):
        if owner.logical_session_id == logical_session_id:
            _session_turn_lifecycle_owners.pop(key, None)


def _session_lifecycle_is_current(
    logical_session_id: str,
    token: _SessionLifecycleToken,
) -> bool:
    key = logical_session_id or "default"
    with _session_state_lock:
        return _session_lifecycle_tokens.get(key) is token


def _acquire_completion_lease(
    fence: _CompletionFence,
    *,
    task_id: str,
) -> Optional[_CompletionLease]:
    """Admit completion and atomically detach its generation-owned inputs."""
    key = fence.logical_session_id or "default"
    with _session_state_lock:
        if _session_lifecycle_tokens.get(key) is not fence.lifecycle_token:
            return None
        _session_state_tokens.pop(key, None)
        state = _session_states.pop(
            key,
            {
                "snapshot": None,
                "activity": _empty_activity(),
                "intermediateFailureDiffs": [],
            },
        )
        episode_inputs = buf.claim_episode_inputs(
            task_id,
            key,
            lifecycle_token=fence.lifecycle_token,
        )
        _completion_leases[fence.lifecycle_token] = (
            _completion_leases.get(fence.lifecycle_token, 0) + 1
        )
        return _CompletionLease(
            fence=fence,
            state=state,
            episode_inputs=episode_inputs,
        )


def _release_completion_lease(lease: _CompletionLease) -> None:
    fence = lease.fence
    if fence.parent_session_id is not None:
        _close_internal_session_control(
            fence.logical_session_id,
            fence.lifecycle_token,
        )
    token = fence.lifecycle_token
    with _session_state_lock:
        remaining = _completion_leases.get(token, 0) - 1
        if remaining > 0:
            _completion_leases[token] = remaining
        else:
            _completion_leases.pop(token, None)
        _completion_condition.notify_all()


def _wait_for_completion_leases(
    lifecycle_tokens: list[Optional[_SessionLifecycleToken]],
) -> None:
    tokens = {
        token
        for token in lifecycle_tokens
        if isinstance(token, _SessionLifecycleToken)
    }
    with _session_state_lock:
        _completion_condition.wait_for(
            lambda: not any(
                _completion_leases.get(token, 0)
                for token in tokens
            )
        )


def _emit_completion(
    **render_args: Any,
) -> None:
    """Render a terminal completion under an already-admitted lease."""
    rendered = session_view.render_complete(**render_args)
    _user_line(rendered)


def _state_for(
    session_id: str,
    cwd: Optional[Path] = None,
    *,
    expected_token: Optional[_SessionLifecycleToken] = None,
) -> Optional[Dict[str, Any]]:
    key = session_id or "default"
    with _session_state_lock:
        lifecycle_token = _session_lifecycle_tokens.get(key)
        if expected_token is not None:
            if lifecycle_token is not expected_token:
                return None
            lifecycle_token = expected_token
        elif lifecycle_token is None:
            lifecycle_token = _SessionLifecycleToken()
            _session_lifecycle_tokens[key] = lifecycle_token
        state = _session_states.get(key)
        if state is not None:
            return state
        state_token = _session_state_tokens.get(key)
        if state_token is None:
            state_token = object()
            _session_state_tokens[key] = state_token

    candidate = {
        "snapshot": session_bridge.snapshot_repository(key, cwd=cwd),
        "activity": _empty_activity(),
        "intermediateFailureDiffs": [],
    }
    with _session_state_lock:
        if (
            _session_lifecycle_tokens.get(key) is not lifecycle_token
            or _session_state_tokens.get(key) is not state_token
        ):
            if expected_token is not None:
                return None
            return candidate
        state = _session_states.get(key)
        if state is None:
            state = candidate
            _session_states[key] = state
        return state


def _pop_state(
    session_id: str,
    *,
    close_lifecycle: bool = False,
    expected_token: Optional[_SessionLifecycleToken] = None,
) -> Optional[Dict[str, Any]]:
    key = session_id or "default"
    lifecycle_token = None
    with _session_state_lock:
        if (
            expected_token is not None
            and _session_lifecycle_tokens.get(key) is not expected_token
        ):
            return None
        _session_state_tokens.pop(key, None)
        state = _session_states.pop(
            key,
            {
                "snapshot": None,
                "activity": _empty_activity(),
                "intermediateFailureDiffs": [],
            },
        )
        if close_lifecycle:
            _pickup_checkpoints.pop(key, None)
            lifecycle_token = _session_lifecycle_tokens.pop(
                key,
                None,
            )
            _discard_turn_lifecycle_owners_locked(key)
    if close_lifecycle:
        buf.discard_session(
            key,
            lifecycle_token=lifecycle_token,
            include_legacy=True,
        )
    return state


def _peek_state(session_id: str) -> Dict[str, Any]:
    key = session_id or "default"
    with _session_state_lock:
        state = _session_states.get(key)
        checkpoint = dict(
            _pickup_checkpoints.get(key) or _empty_pickup_checkpoint()
        )
        checkpoint["deliveredCanonicalEpisodeIds"] = list(
            checkpoint.get("deliveredCanonicalEpisodeIds") or []
        )
        if state is None:
            return {
                "activity": _empty_activity(),
                "pickupCheckpoint": checkpoint,
            }
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
            "pickupCheckpoint": checkpoint,
        }


def _pickup_repository_identity(
    logical_session_id: str,
    state: Dict[str, Any],
    cwd_value: Any,
) -> _PickupRepositoryIdentity:
    """Resolve current repository identity without replacing the start snapshot."""
    key = logical_session_id or "default"
    with _session_state_lock:
        checkpoint = _pickup_checkpoints.get(key)
        checkpoint_slug = (
            checkpoint.get("repositorySlug")
            if checkpoint is not None
            else None
        )
        checkpoint_cwd = (
            checkpoint.get("repositoryCwd")
            if checkpoint is not None
            else None
        )

    if not isinstance(cwd_value, str) or not cwd_value:
        snapshot = state.get("snapshot")
        snapshot_slug = (
            snapshot.repository_slug
            if snapshot is not None
            else None
        )
        if not isinstance(snapshot_slug, str) or not snapshot_slug.strip():
            return _PickupRepositoryIdentity(
                checkpoint_slug,
                checkpoint_cwd,
                False,
            )
        return _PickupRepositoryIdentity(
            snapshot_slug,
            None,
            True,
        )

    try:
        resolved = str(Path(cwd_value).resolve())
    except Exception as exc:
        logger.warning(
            "jinn: pickup repository resolve failed open: %s",
            exc,
        )
        return _PickupRepositoryIdentity(
            checkpoint_slug,
            checkpoint_cwd,
            False,
        )
    if checkpoint_cwd == resolved:
        return _PickupRepositoryIdentity(
            checkpoint_slug,
            resolved,
            True,
        )

    try:
        snapshot = session_bridge.snapshot_repository(
            f"{logical_session_id}:pickup",
            cwd=Path(resolved),
        )
    except Exception as exc:
        logger.warning(
            "jinn: pickup repository probe failed open: %s",
            exc,
        )
        return _PickupRepositoryIdentity(
            checkpoint_slug,
            checkpoint_cwd,
            False,
        )
    snapshot_slug = (
        snapshot.repository_slug
        if snapshot is not None
        else None
    )
    if not isinstance(snapshot_slug, str) or not snapshot_slug.strip():
        return _PickupRepositoryIdentity(
            checkpoint_slug,
            checkpoint_cwd,
            False,
        )
    return _PickupRepositoryIdentity(
        snapshot_slug,
        resolved,
        True,
    )


def _reserve_pickup_checkpoint(
    logical_session_id: str,
    *,
    expected_token: _SessionLifecycleToken,
    is_first_turn: bool,
    stable_task_id: Optional[str],
    repository_slug: Optional[str],
    repository_cwd: Optional[str],
    repository_verified: bool,
) -> Optional[_PickupReservation]:
    """Atomically decide and reserve a pickup, returning prior exclusions.

    Reservation happens before the process call so concurrent hooks for the
    same checkpoint cannot both invoke it. The process runs after this helper
    releases ``_session_state_lock``.
    """
    key = logical_session_id or "default"
    with _session_state_lock:
        if _session_lifecycle_tokens.get(key) is not expected_token:
            return None
        checkpoint = _pickup_checkpoints.get(key)
        if checkpoint is None:
            checkpoint = _empty_pickup_checkpoint()
            _pickup_checkpoints[key] = checkpoint
        has_run = bool(checkpoint.get("hasRun"))
        checkpoint_changed = has_run and (
            (
                stable_task_id is not None
                and stable_task_id != checkpoint.get("taskId")
            )
            or (
                repository_verified
                and repository_slug != checkpoint.get("repositorySlug")
            )
        )
        should_pick_up = (is_first_turn and not has_run) or checkpoint_changed
        if not should_pick_up:
            if (
                has_run
                and repository_verified
                and repository_slug == checkpoint.get("repositorySlug")
            ):
                checkpoint["repositoryCwd"] = repository_cwd
            return None

        excluded = list(
            checkpoint.get("deliveredCanonicalEpisodeIds") or []
        )
        checkpoint["hasRun"] = True
        checkpoint["taskId"] = stable_task_id
        if repository_verified:
            checkpoint["repositorySlug"] = repository_slug
            checkpoint["repositoryCwd"] = repository_cwd
        return _PickupReservation(
            excluded_canonical_episode_ids=tuple(excluded),
            token=expected_token,
        )


def _merge_pickup_deliveries(
    logical_session_id: str,
    reservation: _PickupReservation,
    delivered_canonical_episode_ids: tuple[str, ...],
) -> None:
    key = logical_session_id or "default"
    with _session_state_lock:
        if _session_lifecycle_tokens.get(key) is not reservation.token:
            return
        checkpoint = _pickup_checkpoints.get(key)
        if checkpoint is None:
            return
        delivered = checkpoint["deliveredCanonicalEpisodeIds"]
        for episode_id in delivered_canonical_episode_ids:
            if episode_id not in delivered:
                delivered.append(episode_id)


def _close_session_lifecycle(
    session_id: str,
    *,
    expected_token: Optional[_SessionLifecycleToken] = None,
) -> Optional[_SessionLifecycleToken]:
    """Atomically invalidate and remove all host-owned session control state."""
    key = session_id or "default"
    with _session_state_lock:
        current_token = _session_lifecycle_tokens.get(key)
        if (
            expected_token is not None
            and current_token is not expected_token
        ):
            return None
        _session_states.pop(key, None)
        _session_state_tokens.pop(key, None)
        _pickup_checkpoints.pop(key, None)
        lifecycle_token = _session_lifecycle_tokens.pop(key, None)
        _discard_turn_lifecycle_owners_locked(key)
        return (
            lifecycle_token
            if isinstance(
                lifecycle_token,
                _SessionLifecycleToken,
            )
            else None
        )


def _finish_internal_session(
    parent_session_id: Optional[str],
    logical_session_id: str,
    lifecycle_token: _SessionLifecycleToken,
) -> None:
    """Close child control state, then release its parent ownership."""
    if parent_session_id is None:
        return
    _close_internal_session_control(
        logical_session_id,
        lifecycle_token,
    )
    _release_internal_session(
        parent_session_id,
        expected_logical_session_id=logical_session_id,
    )


def _close_internal_session_control(
    logical_session_id: str,
    lifecycle_token: _SessionLifecycleToken,
) -> None:
    """Close child-local state while parent ownership stays registered."""
    closed_token = _close_session_lifecycle(
        logical_session_id,
        expected_token=lifecycle_token,
    )
    buf.discard_session(
        logical_session_id,
        lifecycle_token=closed_token or lifecycle_token,
        include_legacy=True,
    )


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


def _on_session_finalize(session_id: str = "", **_: Any) -> None:
    """Invalidate one host generation and await its admitted completions."""
    parent_session_id = session_id or "default"
    parent_token = _close_session_lifecycle(parent_session_id)
    internal_lifecycles = _internal_sessions_for_parent(
        parent_session_id,
        parent_token,
    )
    closed_lifecycles = [
        (
            parent_session_id,
            parent_token,
        )
    ]
    for internal_session_id, internal_token in internal_lifecycles:
        _close_session_lifecycle(
            internal_session_id,
            expected_token=internal_token,
        )
        closed_lifecycles.append(
            (
                internal_session_id,
                internal_token,
            )
        )
    for owned_session_id, lifecycle_token in closed_lifecycles:
        buf.discard_session(
            owned_session_id,
            lifecycle_token=lifecycle_token,
            include_legacy=True,
        )
    _wait_for_completion_leases(
        [
            lifecycle_token
            for _owned_session_id, lifecycle_token
            in closed_lifecycles
        ]
    )
    if parent_token is not None:
        _release_all_internal_sessions(
            parent_session_id,
            expected_parent_token=parent_token,
        )


def _on_pre_llm_call(
    session_id: str = "",
    user_message: str = "",
    is_first_turn: bool = False,
    model: str = "",
    platform: str = "",
    task_id: str = "",
    stable_task_id: Any = _STABLE_TASK_ID_UNSET,
    turn_id: str = "",
    **_: Any,
) -> Optional[Dict[str, str]]:
    identity = _session_identity(session_id)
    if identity is None:
        return None
    (
        logical_session_id,
        session_kind,
        parent_session_id,
        lifecycle_token,
    ) = identity
    if not _bind_session_turn_lifecycle(
        session_id,
        turn_id,
        logical_session_id,
        lifecycle_token,
    ):
        return None
    # Local capture — UNCONDITIONAL (mono#1714): filling the buffer never
    # leaves the machine; local retention, mining, and distillation happen by
    # default. Not gated on is_first_turn: the buffer is keyed per session and
    # record_first_turn is setdefault-idempotent, so calling it every turn
    # recovers the summary/model even when the first-turn signal is unreliable
    # on some provider paths (mono #1404). Only the share step (a task leaving
    # the machine) is gated — see _on_session_end.
    buf.record_first_turn(
        task_id,
        logical_session_id,
        user_message,
        model,
        platform,
        lifecycle_token=lifecycle_token,
    )
    # Ordered user-turn span for the EpisodeV1 trajectory (mono #1662).
    # record_first_turn stores metadata only; this appends the turn span so it
    # precedes this turn's tool calls (post_tool_call) and the assistant turn
    # (post_llm_call). Local capture, so unconditional per mono#1714.
    buf.record_user_turn(
        task_id,
        logical_session_id,
        user_message,
        lifecycle_token=lifecycle_token,
    )
    # Consumption side — NEVER consent-gated: evidence-first corpus pickup.
    # Returns {"context": ...} (injected into the user message, cache-safe)
    # on the first turn and whenever a stable task/repository checkpoint
    # changes. Fails open inside pickup_with_outcome().
    state = _state_for(
        logical_session_id,
        expected_token=lifecycle_token,
    )
    if state is None:
        # Finalization may race a pre-hook while local capture is in progress.
        # Remove any late capture rows before returning from the stale hook.
        buf.discard(
            task_id,
            logical_session_id,
            lifecycle_token=lifecycle_token,
        )
        return None
    task_identity = (
        task_id
        if stable_task_id is _STABLE_TASK_ID_UNSET
        else stable_task_id
    )
    normalized_stable_task_id = (
        task_identity.strip()
        if isinstance(task_identity, str) and task_identity.strip()
        else None
    )
    repository_identity = _pickup_repository_identity(
        logical_session_id,
        state,
        _.get("cwd") or _.get("working_directory"),
    )
    reservation = _reserve_pickup_checkpoint(
        logical_session_id,
        expected_token=lifecycle_token,
        is_first_turn=is_first_turn,
        stable_task_id=normalized_stable_task_id,
        repository_slug=repository_identity.repository_slug,
        repository_cwd=repository_identity.repository_cwd,
        repository_verified=repository_identity.verified,
    )
    if reservation is None:
        return None

    outcome = pickup.pickup_with_outcome(
        user_message,
        runner=_runner,
        activity=state["activity"],
        session_id=logical_session_id,
        model=model,
        repository_slug=repository_identity.repository_slug,
        session_kind=session_kind,
        parent_session_id=parent_session_id,
        exclude_canonical_episode_ids=(
            reservation.excluded_canonical_episode_ids
        ),
    )
    _merge_pickup_deliveries(
        logical_session_id,
        reservation,
        outcome.delivered_canonical_episode_ids,
    )
    return outcome.context


def _on_post_tool_call(
    tool_name: str = "",
    args: Any = None,
    session_id: str = "",
    task_id: str = "",
    turn_id: str = "",
    tool_call_id: str = "",
    result: Any = None,
    duration_ms: Optional[int] = None,
    **_: Any,
) -> None:
    owner = _post_hook_lifecycle(session_id, turn_id)
    if owner is None:
        return
    logical_session_id = owner.logical_session_id
    lifecycle_token = owner.lifecycle_token
    # Local capture — UNCONDITIONAL (mono#1714): recording tool calls never
    # leaves the machine.
    buf.record_tool_call(
        task_id,
        logical_session_id,
        tool_name,
        tool_call_id,
        args,
        result,
        duration_ms,
        lifecycle_token=lifecycle_token,
    )
    state = _state_for(
        logical_session_id,
        expected_token=lifecycle_token,
    )
    if state is None:
        buf.discard(
            task_id,
            logical_session_id,
            lifecycle_token=lifecycle_token,
        )
        return
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
    turn_id: str = "",
    user_message: str = "",
    assistant_response: str = "",
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    **_: Any,
) -> None:
    owner = _post_hook_lifecycle(session_id, turn_id)
    if owner is None:
        return
    logical_session_id = owner.logical_session_id
    lifecycle_token = owner.lifecycle_token
    # Complete the EpisodeV1 turn (mono #1662): the assistant span lands AFTER
    # this turn's tool calls (post_tool_call fires inside the tool loop, which
    # completes before post_llm_call). Local capture is UNCONDITIONAL (mono#1714)
    # — the buffer never leaves the machine; only the share step is gated.
    buf.record_assistant_turn(
        task_id,
        logical_session_id,
        assistant_response,
        lifecycle_token=lifecycle_token,
    )
    # Record tokens only when the host reports meaningful usage. Zero/zero (the
    # getattr default when the agent has no usage) is treated as "no usage" so
    # cost.tokens is OMITTED rather than emitted as {0,0} (AC2, mono #1662).
    if input_tokens or output_tokens:
        buf.record_tokens(
            task_id,
            logical_session_id,
            input_tokens or 0,
            output_tokens or 0,
            lifecycle_token=lifecycle_token,
        )
    if not _session_lifecycle_is_current(
        logical_session_id,
        lifecycle_token,
    ):
        buf.discard(
            task_id,
            logical_session_id,
            lifecycle_token=lifecycle_token,
        )


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


def _complete_session_end(
    owner: _TurnLifecycleOwner,
    completion_lease: _CompletionLease,
    session_id: str = "",
    task_id: str = "",
    turn_id: str = "",
    completed: bool = False,
    interrupted: bool = False,
    skills_loadout: Optional[list] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    **_: Any,
) -> None:
    """Complete one turn under its caller's already-admitted owner lease."""
    logical_session_id = owner.logical_session_id
    lifecycle_token = owner.lifecycle_token
    host_session_id = session_id or "default"
    is_internal = logical_session_id != host_session_id
    session_kind = "host-internal" if is_internal else "user"
    parent_session_id = host_session_id[:128] if is_internal else None
    _release_session_turn_lifecycle(
        session_id,
        turn_id,
        expected_token=lifecycle_token,
    )
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

    # The canonical EpisodeV1 is the one local-learning and contribution source.
    # C7 retired the duplicate CapturedTask tee, so session end pops exactly the
    # episode shape and never writes a second trajectory file.
    episode = buf.assemble_claimed_episode(
        completion_lease.episode_inputs,
        completed,
        interrupted,
        publish_consented=publish_enabled,
        skills_loadout=skills_loadout or [],
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )
    state = completion_lease.state

    if episode is None:
        _emit_completion(
            summary=None,
            activity=state.get("activity") or {},
            capture_status="unavailable",
            local_learning_status="unavailable",
            contribution=None,
            candidate_created=False,
        )
        return

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
            "off" if distill.cached_mode(_runner) == "off"
            else "pending" if fallback_path is not None
            else "unavailable"
        )
        activity = state.get("activity") or {}
        _emit_completion(
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
        )
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
            _clear_veto(
                logical_session_id,
                expected_token=lifecycle_token,
            )
        learning_status = (
            "off" if distill.cached_mode(_runner) == "off"
            else "pending"
        )
        _emit_completion(
            summary=result.get("summary"),
            activity=state.get("activity") or {},
            capture_status="captured",
            local_learning_status=learning_status,
            contribution=result.get("contribution"),
            candidate_created=candidate is not None,
        )


def _on_session_end(
    session_id: str = "",
    task_id: str = "",
    turn_id: str = "",
    completed: bool = False,
    interrupted: bool = False,
    skills_loadout: Optional[list] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    **kwargs: Any,
) -> None:
    """Admit the exact owner before any terminal completion side effect."""
    owner = _post_hook_lifecycle(session_id, turn_id)
    if owner is None:
        return
    host_session_id = session_id or "default"
    is_internal = owner.logical_session_id != host_session_id
    parent_session_id = (
        host_session_id[:128] if is_internal else None
    )
    completion_lease = _acquire_completion_lease(
        _CompletionFence(
            logical_session_id=owner.logical_session_id,
            lifecycle_token=owner.lifecycle_token,
            parent_session_id=parent_session_id,
        ),
        task_id=task_id,
    )
    if completion_lease is None:
        if is_internal:
            _finish_internal_session(
                parent_session_id,
                owner.logical_session_id,
                owner.lifecycle_token,
            )
        return
    try:
        _complete_session_end(
            owner=owner,
            completion_lease=completion_lease,
            session_id=session_id,
            task_id=task_id,
            turn_id=turn_id,
            completed=completed,
            interrupted=interrupted,
            skills_loadout=skills_loadout,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            **kwargs,
        )
    finally:
        _release_completion_lease(completion_lease)
        if is_internal:
            _finish_internal_session(
                parent_session_id,
                owner.logical_session_id,
                owner.lifecycle_token,
            )


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
        lifecycle_token = _current_session_lifecycle_token(session_id)
        return session_view.render_current(
            activity=state.get("activity") or {},
            capture_active=buf.has_capture(
                task_id,
                session_id,
                lifecycle_token=lifecycle_token,
            ),
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
        lifecycle_token = _current_session_lifecycle_token(session_id)
        if not buf.has_steps(
            task_id,
            session_id,
            lifecycle_token=lifecycle_token,
        ):
            # mono issue #1383 — vetoing nothing must not return the success
            # copy: with no capture under way the mark would be a no-op.
            return "No active task to veto — veto marks the task currently running in this session."
        _record_veto(session_id)
        return (
            f"Session {session_id} is vetoed — its evidence stays local. "
            "A contribution already published is immutable."
        )

    return _JINN_HELP


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
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_command(
        "jinn",
        handler=_handle_jinn,
        description="Jinn layer: session, history, and automatic evidence state.",
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
