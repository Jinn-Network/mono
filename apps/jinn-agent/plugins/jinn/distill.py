"""Local distillation tee plus EpisodeV1 fallback persistence.

The rung-1 ``jinn-layer distill`` loop reads its own captures directory, so
the plugin tees the legacy CapturedTask shape there. Complete EpisodeV1
persistence is owned canonically by the core session-end process bridge; the
separate episodes directory is used only when that bridge cannot confirm its
write. The retired raw pending/publication queue is never touched here.

Discipline unchanged: all distillation logic (scrub, clustering, consent mode,
staging) lives in ``jinn-layer``; this module only mirrors the layer's default
captures path and reads ``distill status --json`` for gating.

Gating (mono#1714 — local distillation is ungated; only an explicit ``off``
mode opts out; sharing consent is never consulted):

  ============= ==========================================
  distill mode  tee?
  ============= ==========================================
  unset         yes — reserve material for the first run
  local / defer yes
  off           no ("off = stop reserving captures")
  unavailable   no — old layer without the status verb
  ============= ==========================================

Reserving captures never leaves the machine — it can NEVER cause a share;
the share path stays gated on the single share consent (see ``_on_session_end``).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import jinn_layer

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
    """Where the host's EpisodeV1 fallback lands — distinct from captures.

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

    ``unavailable`` = the layer predates the status verb (or errored). Local
    capture still reserves material so distillation can resume when restored.
    """
    global _cached_mode
    if _cached_mode is None or refresh:
        status = distill_status(runner)
        mode = status.get("mode") if status else None
        _cached_mode = mode if isinstance(mode, str) and mode else "unavailable"
    return _cached_mode


def should_tee(runner: Optional[Runner] = None) -> bool:
    """Local distillation is ungated (mono#1714): reserve captures by default.

    The only opt-out is an explicit ``off`` mode from the layer. Sharing
    consent and process-bridge availability are never consulted — local
    distillation never leaves the machine.
    """
    mode = cached_mode(runner)
    if mode == "off":
        return False
    return True  # local / defer / unset / unavailable — reserve locally


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

    This is the legacy shape consumed by ``parseCapturedTask``. Best-effort:
    a tee failure must never break a session end.
    """
    try:
        if not should_tee(runner):
            return None
        path = jinn_layer.write_task_file(task, captures_dir(), session_id)
        prune_captures()
        return path
    except Exception:
        return None


def write_episode_fallback(episode: Dict[str, Any]) -> Optional[Path]:
    """Persist one complete EpisodeV1 when the core did not.

    This path is deliberately independent of ``jinn-layer`` status and the
    legacy distill mode: it is the host's evidence-safety fallback. A complete
    private temp file is atomically linked at the canonical path, so concurrent
    retries are idempotent while different content for the same id fails closed.
    """
    try:
        if episode.get("schemaVersion") != "jinn.episode.v1":
            return None
        episode_id = episode.get("episodeId")
        if not isinstance(episode_id, str) or not episode_id:
            return None
        safe = re.fullmatch(r"[A-Za-z0-9._-]+", episode_id) and episode_id not in (".", "..")
        stem = (
            episode_id
            if safe
            else f"episode-{hashlib.sha256(episode_id.encode('utf-8')).hexdigest()}"
        )
        serialized = json.dumps(
            episode,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n"
        canonical_episode = json.loads(serialized)
        directory = episodes_dir()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
        path = directory / f"{stem}.episode.json"

        def existing_is_identical() -> bool:
            try:
                if path.is_symlink() or not path.is_file():
                    return False
                os.chmod(path, 0o600)
                existing = json.loads(path.read_text(encoding="utf-8"))
                return existing == canonical_episode
            except (OSError, ValueError, TypeError):
                return False

        if os.path.lexists(path):
            if not existing_is_identical():
                return None
            os.chmod(path, 0o600)
            return path

        fd = -1
        tmp_path: Optional[Path] = None
        try:
            fd, tmp_name = tempfile.mkstemp(
                prefix=f".{stem}.", suffix=".tmp", dir=directory
            )
            tmp_path = Path(tmp_name)
            os.fchmod(fd, 0o600)
            handle = os.fdopen(fd, "w", encoding="utf-8", newline="")
            fd = -1
            with handle:
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp_path, 0o600)
            try:
                # Unlike rename/replace, link never overwrites a concurrent
                # winner. The destination appears only after the temp is whole.
                os.link(tmp_path, path)
            except FileExistsError:
                if not existing_is_identical():
                    return None
                os.chmod(path, 0o600)
                return path
            os.chmod(path, 0o600)
            return path
        finally:
            if fd >= 0:
                os.close(fd)
            if tmp_path is not None:
                try:
                    tmp_path.unlink()
                except FileNotFoundError:
                    pass
    except Exception:
        return None
