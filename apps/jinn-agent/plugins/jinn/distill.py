"""Local distillation wiring — the captures tee + layer status reads (mono #1537).

The rung-1 ``jinn-layer distill`` loop reads its own captures dir
(``~/.jinn-client/harness-layer/captures``) — and until now nothing wrote it.
The plugin is the producer: at session end the assembled CapturedTask is tee'd
there. That lifecycle is DISTINCT from ``$HERMES_HOME/jinn/pending`` — pending
files are consumed (unlinked) by the publish drain, so pointing the distill
loop at them would race the drain and lose material. Two dirs, two lifecycles.

Discipline unchanged: all distillation logic (scrub, clustering, consent mode,
staging) lives in ``jinn-layer``; this module only mirrors the layer's default
captures path and reads ``distill status --json`` for gating.

Gating (mode from the layer's status read, cached once per process):

  =============== ============= ==========================================
  publish consent distill mode  tee?
  =============== ============= ==========================================
  accepted        unset         yes — reserve material for the first run
  accepted        local / defer yes
  accepted        off           no ("off = stop reserving captures")
  declined/unset  local / defer yes — explicit distill opt-in
  declined/unset  unset / off   no
  any             unavailable   no — old layer without the status verb
  =============== ============= ==========================================

A distill-only opt-in fills the capture buffer but can NEVER cause a publish —
the publish path stays gated on publish consent alone (see ``_on_session_end``).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import consent, jinn_layer

Runner = Callable[[List[str]], Tuple[int, str]]

# Retention: the layer reads only the newest 50 captures and `--resume` skips
# already-distilled ones, so a count cap is sufficient — no age logic.
KEEP_CAPTURES = 200

_cached_mode: Optional[str] = None


def reset() -> None:
    """Drop the per-process mode cache (tests; /jinn distill refreshes explicitly)."""
    global _cached_mode
    _cached_mode = None


def captures_dir() -> Path:
    """The layer's own-captures dir — env override mirrors the layer default."""
    env = (os.environ.get("JINN_LAYER_CAPTURES_DIR") or "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".jinn-client" / "harness-layer" / "captures"


def episodes_dir() -> Path:
    """Where the EpisodeV1 dual-write lands — distinct from captures_dir().

    A separate dir keeps EpisodeV1 records out of the legacy captures dir the
    rung-1 distill loop reads, so the strict ``parseCapturedTask`` reader is
    never even offered an episode file to skip (mono #1662).
    """
    env = (os.environ.get("JINN_LAYER_EPISODES_DIR") or "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".jinn-client" / "harness-layer" / "episodes"


def distill_status(runner: Optional[Runner] = None) -> Optional[Dict[str, Any]]:
    """One `distill status --json` read; None when the layer lacks the verb."""
    try:
        code, out = jinn_layer.run(["distill", "status", "--json"], runner)
    except Exception:
        return None
    if code != 0:
        return None
    try:
        parsed = json.loads(out)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def cached_mode(runner: Optional[Runner] = None, refresh: bool = False) -> str:
    """The persisted distill mode, one subprocess read per process.

    ``unavailable`` = the layer predates the status verb (or errored) — distill
    gating degrades to off; the publish path is unaffected.
    """
    global _cached_mode
    if _cached_mode is None or refresh:
        status = distill_status(runner)
        mode = status.get("mode") if status else None
        _cached_mode = mode if isinstance(mode, str) and mode else "unavailable"
    return _cached_mode


def distill_capture_enabled(runner: Optional[Runner] = None) -> bool:
    """Should the capture buffer fill for distillation alone (publish consent aside)?

    Only an explicit opt-in (mode local/defer) extends the buffer gate — the
    accepted-consent path already fills the buffer, and `unset` without publish
    consent must not capture anything.
    """
    return cached_mode(runner) in ("local", "defer")


def should_tee(runner: Optional[Runner] = None) -> bool:
    """The gating table in the module docstring."""
    mode = cached_mode(runner)
    if mode in ("local", "defer"):
        return True
    if mode == "unset":
        return consent.capture_enabled()
    return False  # off / unavailable


def prune_captures(keep: int = KEEP_CAPTURES) -> None:
    """Best-effort: keep the newest `keep` capture files; never raises."""
    try:
        files = sorted(
            captures_dir().glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for stale in files[keep:]:
            try:
                stale.unlink()
            except OSError:
                pass
    except Exception:
        pass


def tee_capture(task: Dict[str, Any], session_id: str, runner: Optional[Runner] = None) -> Optional[Path]:
    """Reserve the assembled CapturedTask for local distillation.

    Same file shape and sanitisation as the pending write (the layer's
    `parseCapturedTask` reads both). Best-effort: a tee failure must never
    break a session end.
    """
    try:
        if not should_tee(runner):
            return None
        path = jinn_layer.write_task_file(task, captures_dir(), session_id)
        prune_captures()
        return path
    except Exception:
        return None


def write_episode(episode: Optional[Dict[str, Any]], session_id: str, runner: Optional[Runner] = None) -> Optional[Path]:
    """Dual-write the EpisodeV1 record to its own dir (mono #1662).

    Same gating table as ``tee_capture`` (``should_tee``) and the same
    best-effort discipline: an episode-write failure must never break a session
    end. Written to ``episodes_dir()`` so it never collides with the legacy
    capture nor reaches ``parseCapturedTask``.
    """
    try:
        if episode is None or not should_tee(runner):
            return None
        return jinn_layer.write_task_file(episode, episodes_dir(), session_id)
    except Exception:
        return None
