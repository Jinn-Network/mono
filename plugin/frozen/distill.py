"""EpisodeV1 fallback persistence and local-distillation command helpers.

The process contract owns canonical episode persistence. This module supplies
the host-side fallback when that bridge cannot confirm its write, plus status
and command rendering for the independently published layer. C7 retired the
duplicate Hermes CapturedTask tee; no trajectory is written here outside the
canonical episode store.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
import signal
import stat
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import consent, harness, jinn_layer
from . import skills_install

Runner = Callable[[List[str]], Tuple[int, str]]

_EVIDENCE_LOCK_FILE = ".jinn-evidence-store-lock.sqlite"
_EVIDENCE_LOCK_APPLICATION_ID = 0x4A4C4F43
_EVIDENCE_LOCK_SCHEMA_VERSION = "1"

_cached_mode: Optional[str] = None


def reset() -> None:
    """Drop the per-process mode cache (tests; /jinn distill refreshes explicitly)."""
    global _cached_mode
    _cached_mode = None


def episodes_dir() -> Path:
    """Where the host's canonical EpisodeV1 fallback lands."""
    env = (os.environ.get("JINN_LAYER_EPISODES_DIR") or "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".jinn-client" / "harness-layer" / "episodes"


def _assert_private_evidence_dir(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise OSError(f"evidence store must be a regular directory: {directory}")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise OSError(f"evidence store must be owned by uid {os.getuid()}: {directory}")
    os.chmod(directory, 0o700)


def _verified_regular_identity(path: Path) -> tuple[int, int]:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise OSError(f"evidence file must be a regular file: {path}")
    if info.st_nlink != 1:
        raise OSError(f"evidence file must not be hardlinked: {path}")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise OSError(f"evidence file must be owned by uid {os.getuid()}: {path}")
    return info.st_dev, info.st_ino


def _writer_temp_canonical_name(name: str) -> Optional[str]:
    core = re.fullmatch(
        r"\.(.+\.episode\.json)\.\d+\."
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
        r"[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp",
        name,
        re.IGNORECASE,
    )
    if core:
        return core.group(1)
    python = re.fullmatch(r"\.(.+)\.([A-Za-z0-9_-]{8})\.tmp", name)
    return f"{python.group(1)}.episode.json" if python else None


def _assert_linked_publication(info: os.stat_result, path: Path, label: str) -> None:
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise OSError(f"{label} must be a regular file: {path}")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise OSError(f"{label} must be owned by uid {os.getuid()}: {path}")


def _recover_writer_publication_aliases(directory: Path) -> None:
    """Remove a proven writer temp alias left by a crash after link(2)."""
    names = sorted(path.name for path in directory.iterdir())
    for canonical_name in (
        name for name in names if name.endswith(".episode.json")
    ):
        canonical_path = directory / canonical_name
        canonical = canonical_path.lstat()
        if canonical.st_nlink == 1:
            continue
        _assert_linked_publication(
            canonical, canonical_path, "published evidence episode"
        )
        if canonical.st_nlink != 2:
            continue
        identity = (canonical.st_dev, canonical.st_ino)
        aliases = []
        for name in names:
            if _writer_temp_canonical_name(name) != canonical_name:
                continue
            alias = (directory / name).lstat()
            if (alias.st_dev, alias.st_ino) == identity:
                aliases.append(name)
        if len(aliases) != 1:
            continue

        alias_path = directory / aliases[0]
        alias = alias_path.lstat()
        _assert_linked_publication(
            alias, alias_path, "evidence publication temp alias"
        )
        if alias.st_nlink != 2 or (alias.st_dev, alias.st_ino) != identity:
            continue

        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        canonical_fd = os.open(canonical_path, flags)
        alias_fd = os.open(alias_path, flags)
        try:
            opened_canonical = os.fstat(canonical_fd)
            opened_alias = os.fstat(alias_fd)
            _assert_linked_publication(
                opened_canonical, canonical_path, "published evidence episode"
            )
            _assert_linked_publication(
                opened_alias, alias_path, "evidence publication temp alias"
            )
            if (
                opened_canonical.st_nlink != 2
                or opened_alias.st_nlink != 2
                or (opened_canonical.st_dev, opened_canonical.st_ino) != identity
                or (opened_alias.st_dev, opened_alias.st_ino) != identity
            ):
                raise OSError(
                    f"evidence publication aliases changed during recovery: "
                    f"{canonical_path}"
                )
            alias_at_commit = alias_path.lstat()
            canonical_at_commit = canonical_path.lstat()
            if (
                (alias_at_commit.st_dev, alias_at_commit.st_ino) != identity
                or (canonical_at_commit.st_dev, canonical_at_commit.st_ino)
                != identity
            ):
                raise OSError(
                    f"evidence publication aliases changed before recovery: "
                    f"{canonical_path}"
                )
            alias_path.unlink()
            directory_fd = os.open(
                directory,
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            os.close(alias_fd)
            os.close(canonical_fd)
        _verified_regular_identity(canonical_path)

    for name in names:
        if _writer_temp_canonical_name(name) is None:
            continue
        path = directory / name
        try:
            identity = _verified_regular_identity(path)
        except FileNotFoundError:
            continue
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            opened = os.fstat(fd)
            _assert_linked_publication(
                opened, path, "abandoned evidence publication temp"
            )
            if (
                opened.st_nlink != 1
                or (opened.st_dev, opened.st_ino) != identity
            ):
                raise OSError(
                    f"abandoned evidence publication temp changed while opening: {path}"
                )
            at_commit = path.lstat()
            _assert_linked_publication(
                at_commit, path, "abandoned evidence publication temp"
            )
            if (
                at_commit.st_nlink != 1
                or (at_commit.st_dev, at_commit.st_ino) != identity
            ):
                raise OSError(
                    f"abandoned evidence publication temp changed before cleanup: {path}"
                )
            path.unlink()
            directory_fd = os.open(
                directory,
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            os.close(fd)


@contextmanager
def _evidence_store_lock(directory: Path):
    """Crash-recoverable mutex shared with core's scan-through-publish lock."""
    _assert_private_evidence_dir(directory)
    lock_path = directory / _EVIDENCE_LOCK_FILE
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(lock_path, flags, 0o600)
    except FileExistsError:
        fd = -1
    if fd >= 0:
        try:
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)

    identity = _verified_regular_identity(lock_path)
    connection = sqlite3.connect(lock_path, timeout=30, isolation_level=None)
    try:
        if _verified_regular_identity(lock_path) != identity:
            raise OSError(f"evidence store lock changed while opening: {lock_path}")
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("BEGIN IMMEDIATE")
        try:
            application_id = connection.execute("PRAGMA application_id").fetchone()[0]
            tables = [
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            ]
            if application_id == 0 and tables == []:
                connection.execute(
                    f"PRAGMA application_id = {_EVIDENCE_LOCK_APPLICATION_ID}"
                )
                connection.execute(
                    "CREATE TABLE evidence_store_lock_meta "
                    "(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
                )
                connection.execute(
                    "INSERT INTO evidence_store_lock_meta(key, value) VALUES (?, ?)",
                    ("schema_version", _EVIDENCE_LOCK_SCHEMA_VERSION),
                )
            else:
                if application_id != _EVIDENCE_LOCK_APPLICATION_ID:
                    raise OSError(f"not a Jinn evidence store lock: {lock_path}")
                if tables != ["evidence_store_lock_meta"]:
                    raise OSError(f"unexpected evidence store lock schema: {lock_path}")
                row = connection.execute(
                    "SELECT value FROM evidence_store_lock_meta WHERE key = ?",
                    ("schema_version",),
                ).fetchone()
                if row is None or row[0] != _EVIDENCE_LOCK_SCHEMA_VERSION:
                    raise OSError(f"unsupported evidence store lock schema: {lock_path}")
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise

        connection.execute("BEGIN IMMEDIATE")
        try:
            _recover_writer_publication_aliases(directory)
            yield
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
    finally:
        connection.close()
        if _verified_regular_identity(lock_path) != identity:
            raise OSError(f"evidence store lock changed while closing: {lock_path}")
        os.chmod(lock_path, 0o600)


def distill_status(runner: Optional[Runner] = None) -> Optional[Dict[str, Any]]:
    """One `distill status --json` read; None when the layer lacks the verb.

    Scoped with `--out` to the harness's native skills dir — the plugin
    installs there, so coverage/staged/installed must count against it, not
    the layer's default dir (otherwise the hub shows stale numbers after a
    run — e2e finding).
    """
    try:
        code, out, _err = jinn_layer.run(
            ["distill", "status", "--json", "--out", str(skills_install.skills_dir())], runner
        )
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


def write_episode_fallback(episode: Dict[str, Any]) -> Optional[Path]:
    """Persist one complete EpisodeV1 when the core did not.

    This path is deliberately independent of ``jinn-layer`` status and the
    legacy distill mode: it is the host's evidence-safety fallback. A complete
    private temp file is atomically linked at the canonical path, so concurrent
    retries are idempotent while different content for the same id fails closed.
    """
    try:
        canonical_episode = skills_install._validate_episode_write(episode)
        episode_id = canonical_episode["episodeId"]
        suffix = ".episode.json"
        safe = (
            re.fullmatch(r"[A-Za-z0-9._-]+", episode_id)
            and episode_id not in (".", "..")
            and not re.fullmatch(r"episode-[a-f0-9]{64}", episode_id)
            and len(f"{episode_id}{suffix}".encode("utf-8")) <= 255
        )
        stem = (
            episode_id
            if safe
            else f"episode-{hashlib.sha256(episode_id.encode('utf-8')).hexdigest()}"
        )
        serialized = json.dumps(
            canonical_episode,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n"
        canonical_episode = json.loads(serialized)
        directory = episodes_dir()
        path = directory / f"{stem}{suffix}"

        def existing_state() -> str:
            fd = -1
            try:
                expected = _verified_regular_identity(path)
                flags = os.O_RDONLY
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                fd = os.open(path, flags)
                opened = os.fstat(fd)
                if (
                    not stat.S_ISREG(opened.st_mode)
                    or opened.st_nlink != 1
                    or (opened.st_dev, opened.st_ino) != expected
                    or (
                        hasattr(os, "getuid")
                        and opened.st_uid != os.getuid()
                    )
                ):
                    return "collision"
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "r", encoding="utf-8") as handle:
                    fd = -1
                    existing = json.load(handle)
                return "identical" if existing == canonical_episode else "collision"
            except FileNotFoundError:
                return "missing"
            except (OSError, ValueError, TypeError):
                return "collision"
            finally:
                if fd >= 0:
                    os.close(fd)

        def write_locked() -> Optional[Path]:
            state = existing_state()
            if state == "identical":
                return path
            if state == "collision":
                return None

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
                expected = _verified_regular_identity(tmp_path)
                try:
                    # Unlike rename/replace, link never overwrites a concurrent
                    # winner. The destination appears only after the temp is whole.
                    os.link(tmp_path, path)
                except FileExistsError:
                    return path if existing_state() == "identical" else None
                source_info = tmp_path.lstat()
                target_info = path.lstat()
                if (
                    not stat.S_ISREG(source_info.st_mode)
                    or not stat.S_ISREG(target_info.st_mode)
                    or (source_info.st_dev, source_info.st_ino) != expected
                    or (target_info.st_dev, target_info.st_ino) != expected
                ):
                    raise OSError(f"evidence episode changed while publishing: {path}")
                directory_fd = os.open(
                    directory,
                    os.O_RDONLY
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                )
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
                return path
            finally:
                if fd >= 0:
                    os.close(fd)
                if tmp_path is not None:
                    try:
                        tmp_path.unlink()
                    except FileNotFoundError:
                        pass

        with _evidence_store_lock(directory):
            result = write_locked()
        if result is not None:
            try:
                # Reindex uses the same store mutex, so refresh only after the
                # fallback transaction has fully released it. The episode is
                # primary evidence; a derived-view failure never rolls it back.
                jinn_layer.run(["reindex", "--json"], timeout_s=30)
            except Exception:
                pass
        return result
    except Exception:
        return None

# ── Background runner (mono #1539) ──────────────────────────────────────────
#
# A run takes minutes (one frontier call per cluster); the plugin's default
# subprocess runner caps at 120s. Runs therefore spawn DETACHED
# (jinn_layer.spawn: file-redirected output, own session — survives the TUI
# exiting), and a daemon watcher tails the events file (#1533 NDJSON) into
# throttled ◇ lines above the prompt. Run state lives in
# $HERMES_HOME/jinn/distill/: current.json while live, last-run.json after.

Sink = Callable[[str], None]

THROTTLE_S = 5.0
WATCH_POLL_S = 1.0


def _default_sink(msg: str) -> None:
    """stderr, same rendering path as the plugin's other ambient lines."""
    try:
        print(msg, file=sys.stderr, flush=True)
    except Exception:
        pass


def state_dir() -> Path:
    return consent.get_hermes_home() / "jinn" / "distill"


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_current() -> Optional[Dict[str, Any]]:
    path = state_dir() / "current.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def is_running() -> bool:
    current = _read_current()
    return bool(current and isinstance(current.get("pid"), int) and _pid_alive(current["pid"]))


def _archive_current(outcome: str) -> None:
    """current.json → last-run.json with the terminal outcome. Best-effort."""
    try:
        current = _read_current() or {}
        current["outcome"] = outcome
        current["endedAt"] = datetime.now(timezone.utc).isoformat()
        (state_dir() / "last-run.json").write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
        (state_dir() / "current.json").unlink(missing_ok=True)
    except Exception:
        pass


def start_run(spawn: Optional[Callable[..., int]] = None, sink: Optional[Sink] = None) -> Tuple[bool, str]:
    """Spawn a detached stage-only run and start the watcher.

    `--resume` keeps re-runs cheap (already-covered captures are skipped) and
    `--install` is never passed — skills stage; installing is an explicit
    choice (/jinn distill review → install).
    """
    if is_running():
        return False, "a distillation is already running — /jinn distill stop to end it"
    sd = state_dir()
    sd.mkdir(parents=True, exist_ok=True)
    file_id = time.strftime("%Y%m%dT%H%M%S") + f"-{os.getpid()}"
    events_path = sd / f"{file_id}.events.ndjson"
    result_path = sd / f"{file_id}.result.json"
    args = [
        "distill",
        "--progress",
        "ndjson",
        "--json",
        "--resume",
        "--out",
        str(skills_install.skills_dir()),
    ]
    pid = (spawn or jinn_layer.spawn)(args, result_path, events_path)
    current = {
        "pid": pid,
        "fileId": file_id,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "eventsPath": str(events_path),
        "resultPath": str(result_path),
    }
    (sd / "current.json").write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    _start_watcher(sink=sink)
    return True, "◇ distill started — keep working, progress shows here"


def stop_run() -> str:
    if is_running():
        current = _read_current()
        try:
            os.kill(current["pid"], signal.SIGTERM)
        except OSError:
            pass
        _archive_current("stopped")
        return "◇ distill stopped — staged skills are kept; /jinn distill start confirm resumes the rest"
    current = _read_current()
    if current and isinstance(current.get("pid"), int):
        _archive_current("died")
    return "no distillation is running"


def _watch_state(sink: Optional[Sink] = None, now_fn: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """The watcher's mutable state over the CURRENT run — offset, throttle clock."""
    current = _read_current() or {}
    return {
        "eventsPath": current.get("eventsPath", ""),
        "pid": current.get("pid"),
        "offset": 0,
        "lastEmit": {},  # event type → monotonic seconds
        "sink": sink or _default_sink,
        "now": now_fn,
    }


def _line_for_event(event: Dict[str, Any]) -> Optional[str]:
    """Map one progress event to its ambient line; None = print nothing."""
    kind = event.get("event")
    if kind == "run_start":
        n = event.get("toDistill", "?")
        model = event.get("distillModel", "")
        return f"◇ distill started — {n} capture(s) queued behind {model} · runs locally, keep working"
    if kind == "cluster_end":
        pos = f"{event.get('index', '?')}/{event.get('total', '?')}"
        if event.get("outcome") == "published":
            return f"◇ distill {pos} — staged \"{event.get('skillName', '?')}\""
        if event.get("outcome") == "error":
            return f"◇ distill {pos} — cluster failed (kept going)"
        return None  # rejected: a quality gate did its job; the summary covers it
    if kind == "run_end":
        outcome = event.get("outcome")
        published = event.get("published") or []
        if outcome == "empty":
            return "◇ distill — nothing to distill"
        if outcome == "partial":
            return (
                f"◇ distill ended early — {len(published)} skill(s) staged, "
                f"{event.get('errorCount', '?')} cluster(s) failed · /jinn distill start confirm resumes"
            )
        return f"◇ distill done — {len(published)} skill(s) staged · /jinn distill review"
    return None  # cluster_plan / cluster_start / heartbeat: liveness only


def _drain_events(state: Dict[str, Any]) -> bool:
    """One watcher step: read new event lines, print throttled ◇ lines.

    Returns True when the run is over (run_end seen, or the pid died without
    one — archived as `died`). Never raises.
    """
    try:
        path = Path(state["eventsPath"]) if state.get("eventsPath") else None
        text = ""
        if path is not None and path.exists():
            raw = path.read_bytes()
            chunk = raw[state["offset"] :]
            last_newline = chunk.rfind(b"\n")
            if last_newline == -1:
                text = ""
            else:
                consumed = last_newline + 1
                state["offset"] += consumed
                text = chunk[:consumed].decode("utf-8", errors="replace")
        done_outcome: Optional[str] = None
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue  # plain-text warnings share stderr — the v filter
            if not isinstance(event, dict) or event.get("v") != 1:
                continue
            msg = _line_for_event(event)
            if event.get("event") == "run_end":
                done_outcome = str(event.get("outcome") or "ok")
            if msg is None:
                continue
            kind = str(event.get("event"))
            now = state["now"]()
            last = state["lastEmit"].get(kind)
            # run_start / run_end always print; per-cluster lines throttle.
            if kind == "cluster_end" and last is not None and (now - last) < THROTTLE_S:
                continue
            state["lastEmit"][kind] = now
            state["sink"](msg)
        if done_outcome is not None:
            # The pointer record; the layer's run log holds the full facts.
            _archive_current(done_outcome)
            return True
        pid = state.get("pid")
        if isinstance(pid, int) and not _pid_alive(pid):
            state["sink"]("◇ distill — previous run died mid-way · staged skills kept, /jinn distill start confirm resumes")
            _archive_current("died")
            return True
        return False
    except Exception:
        return False  # the watcher must never raise


def _watch_loop(sink: Optional[Sink]) -> None:
    state = _watch_state(sink=sink)
    while True:
        if _drain_events(state):
            return
        time.sleep(WATCH_POLL_S)


def _start_watcher(sink: Optional[Sink] = None) -> None:
    thread = threading.Thread(target=_watch_loop, args=(sink,), name="jinn-distill-watch", daemon=True)
    thread.start()


def reattach_watcher(sink: Optional[Sink] = None) -> None:
    """On plugin start: pick up a run left over from a previous process."""
    current = _read_current()
    if not current:
        return
    pid = current.get("pid")
    if isinstance(pid, int) and _pid_alive(pid):
        _start_watcher(sink=sink)
        return
    (sink or _default_sink)(
        "◇ distill — previous run died mid-way · staged skills kept, /jinn distill start confirm resumes"
    )
    _archive_current("died")


# ── Payoff surface (mono #1550) ──────────────────────────────────────────────
#
# The join: the harness's usage sidecar ($HERMES_HOME/skills/.usage.json,
# keyed by skill NAME, bumped by the native skill tools) × the .jinn-ref
# markers whose ref starts with `local-distill:`. Sessions snapshot at start,
# diff at end, and print one ◇ line per used distilled skill (cap 3).

PAYOFF_LINE_CAP = 3


def _distilled_markers() -> Dict[str, int]:
    """name → provenance_count for installed skills with a local-distill ref."""
    out: Dict[str, int] = {}
    directory = skills_install.skills_dir()
    if not directory.exists():
        return out
    for child in directory.iterdir():
        marker = child / ".jinn-ref"
        if not (child.is_dir() and marker.exists()):
            continue
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
        except Exception:
            continue
        ref = str(data.get("ref", ""))
        if not ref.startswith("local-distill:"):
            continue
        count = data.get("provenance_count")
        out[child.name] = int(count) if isinstance(count, int) else 0
    return out


def _read_usage() -> Dict[str, Dict[str, Any]]:
    """The upstream usage sidecar, read directly (never written here)."""
    path = skills_install.skills_dir() / ".usage.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def snapshot_usage() -> Dict[str, int]:
    """use_count per installed DISTILLED skill, at session start."""
    usage = _read_usage()
    snapshot: Dict[str, int] = {}
    for name in _distilled_markers():
        rec = usage.get(name)
        count = rec.get("use_count") if isinstance(rec, dict) else 0
        snapshot[name] = int(count) if isinstance(count, int) else 0
    return snapshot


def payoff_lines(snapshot: Dict[str, int]) -> List[str]:
    """◇ lines for distilled skills used since `snapshot` (cap 3). Never raises."""
    try:
        markers = _distilled_markers()
        usage = _read_usage()
        lines: List[str] = []
        for name, provenance_count in sorted(markers.items()):
            rec = usage.get(name)
            count = rec.get("use_count") if isinstance(rec, dict) else 0
            count = int(count) if isinstance(count, int) else 0
            if count > snapshot.get(name, 0):
                sources = f"{provenance_count} of your captures" if provenance_count else "your captures"
                lines.append(f"◇ skill used — {name} · distilled from {sources}")
            if len(lines) >= PAYOFF_LINE_CAP:
                break
        return lines
    except Exception:
        return []


# ── /jinn distill — the in-session surface (mono #1538) ─────────────────────
#
# All handlers return stateless strings (input() would deadlock the TUI; the
# two-step pattern from /jinn consent covers anything that needs confirming).
# First-run detection is facts-over-flags: the FACT
# is `mode == "unset"` from the layer's status read; the only stored flag is
# that the splash was shown.

def _update_layer_line() -> str:
    """Host-native layer refresh copy shared by stock Hermes and the fork."""
    return (
        "The Jinn layer here doesn't know distillation yet — update it:\n"
        f"  {harness.cli_name()} plugins update jinn"
    )


def ux_flags_path() -> Path:
    return consent.get_hermes_home() / "jinn" / "distill-ux.json"


def load_ux_flags() -> Dict[str, object]:
    """Pure seen-flags only — never mode, consent, or run state."""
    path = ux_flags_path()
    if not path.exists():
        return {"splash_shown": False, "payoff_invited": False}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {
            "splash_shown": bool(data.get("splash_shown", False)),
            "payoff_invited": bool(data.get("payoff_invited", False)),
        }
    except Exception:
        return {"splash_shown": False, "payoff_invited": False}


def mark_ux_flag(name: str) -> None:
    if name not in ("splash_shown", "payoff_invited"):
        raise ValueError(f"unknown distill ux flag: {name}")
    flags = load_ux_flags()
    flags[name] = True
    path = ux_flags_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(flags, indent=2) + "\n", encoding="utf-8")


def render_splash(status: Dict[str, Any]) -> str:
    count = status.get("capturesCount", 0)
    provider = status.get("distillProvider", "claude")
    model = status.get("distillModel", "")
    return "\n".join(
        [
            "◇ distill — turn your own work into reusable skills",
            "",
            "  As you work, completed tasks are reserved on this machine as",
            f"  captures ({count} so far). A distillation run reads them and writes",
            "  SKILL.md files the agent picks up on later tasks — fully locally:",
            "  nothing is published, nothing leaves this machine.",
            "",
            f"  distiller   {provider} · {model}",
            "              (the frontier model that WRITES the skills — distinct",
            "              from the runtime model your sessions run on)",
            "",
            "  start one   /jinn distill start",
            "  or decide later — captures keep accruing either way.",
        ]
    )


def render_hub(status: Dict[str, Any]) -> str:
    mode = status.get("mode", "unset")
    captures = status.get("capturesCount", 0)
    uncovered = status.get("uncoveredCount", 0)
    staged = status.get("stagedCount", 0)
    installed = status.get("installedCount", 0)
    provider = status.get("distillProvider", "claude")
    model = status.get("distillModel", "")
    last = status.get("lastRun")
    if isinstance(last, dict):
        last_line = (
            f"{last.get('startedAt', '?')}  {last.get('outcome', '?')} — "
            f"{len(last.get('published', []) or [])} distilled, {len(last.get('installed', []) or [])} installed"
        )
    else:
        last_line = "never · /jinn distill start"
    lines = [
        "◇ distill",
        f"  mode        {mode}",
        f"  captures    {uncovered} of {captures} not yet distilled",
        f"  staged      {staged}" + ("  → /jinn distill review" if staged else ""),
        f"  installed   {installed}",
        f"  distiller   {provider} · {model}",
        f"  last run    {last_line}",
    ]
    return "\n".join(lines)


def handle_command(parts: List[str], runner: Optional[Runner] = None) -> str:
    """`/jinn distill ...` — dispatch on the first word after `distill`."""
    action = parts[0] if parts else ""

    if action == "start":
        # Two-step (the /jinn consent precedent): `start` shows the spend
        # facts, `start confirm` begins. A run is a frontier-model pass — it
        # runs locally and nothing leaves, but it is still a spend.
        if is_running():
            return "a distillation is already running — /jinn distill stop to end it"
        status = distill_status(runner)
        if status is None:
            return _update_layer_line()
        uncovered = status.get("uncoveredCount", 0)
        if not uncovered:
            return "nothing to distill yet — captures accrue as you work; check back after a few tasks"
        model = status.get("distillModel", "")
        if parts[1:2] == ["confirm"]:
            if status.get("mode") != "local":
                # `unset` and `defer` both mean "no standing local consent" —
                # and this explicit two-step start IS that consent. Record it
                # the same way the CLI flag does, or the spawned run would
                # read the persisted mode and silently run nothing.
                code, out, err = jinn_layer.run(["distill", "--where", "local", "--json"], runner)
                if code != 0:
                    return (err or out).strip() or _update_layer_line()
                cached_mode(runner, refresh=True)
            ok, msg = start_run()
            return msg
        return "\n".join(
            [
                "◇ distill — ready to run",
                "",
                f"  captures    {uncovered} not yet distilled → up to {uncovered} cluster(s)",
                f"  distiller   {model} — a frontier pass, one call per cluster",
                "  where       locally, on this machine; nothing is published",
                "",
                "  begin with  /jinn distill start confirm",
                "  (keep working while it runs — progress shows here)",
            ]
        )

    if action == "stop":
        return stop_run()

    if action == "review":
        code, out, err = jinn_layer.run(
            ["distill", "staged", "--json", "--out", str(skills_install.skills_dir())], runner
        )
        if code != 0:
            return (err or out).strip() or _update_layer_line()
        try:
            staged = json.loads(out)
        except ValueError:
            return _update_layer_line()
        if not staged:
            return "nothing staged — /jinn distill start runs a distillation over your captures"
        lines = ["◇ distilled skills — staged, waiting for your choice", ""]
        for skill in staged:
            name = skill.get("name", "?")
            provenance = skill.get("provenance") or []
            sources = ", ".join(str(p).replace("local-capture:", "") for p in provenance)
            lines.append(f"  {name}")
            lines.append(f"    helps  {skill.get('description', '')}")
            lines.append(f"    from   {len(provenance)} capture(s): {sources}")
            lines.append("")
        lines.append("  install with  /jinn distill install <name> · /jinn distill install all")
        return "\n".join(lines)

    if action == "install":
        target = parts[1] if len(parts) > 1 else ""
        if not target:
            return "usage: /jinn distill install <name>|all"
        skills_dir = skills_install.skills_dir()
        # Read the staged provenance FIRST — the install below clears the
        # staged copies, and the marker (payoff join, uninstall guard) needs it.
        staged_code, staged_out, _staged_err = jinn_layer.run(
            ["distill", "staged", "--json", "--out", str(skills_dir)], runner
        )
        provenance_by_name: Dict[str, List[str]] = {}
        if staged_code == 0:
            try:
                for skill in json.loads(staged_out):
                    provenance_by_name[str(skill.get("name"))] = list(skill.get("provenance") or [])
            except ValueError:
                pass
        selector = ["--all"] if target == "all" else [target]
        code, out, err = jinn_layer.run(
            ["distill", "install", *selector, "--json", "--out", str(skills_dir)], runner
        )
        if code != 0:
            return (err or out).strip() or _update_layer_line()
        try:
            result = json.loads(out)
        except ValueError:
            return _update_layer_line()
        installed = result.get("installed") or []
        if not installed:
            return "nothing staged — /jinn distill start runs a distillation over your captures"
        lines = []
        for row in installed:
            name = str(row.get("name"))
            provenance = provenance_by_name.get(name, [])
            marker = skills_dir / name / ".jinn-ref"
            try:
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text(
                    json.dumps(
                        {
                            "ref": f"local-distill:{name}",
                            "provenance": provenance,
                            "provenance_count": len(provenance),
                        }
                    )
                    + "\n",
                    encoding="utf-8",
                )
            except OSError:
                pass
            lines.append(f"installed  {name}  →  {row.get('path', '')}")
        lines.append("The agent's skill loader picks these up from here.")
        # First install: one-time invitation to close the loop (mono #1550).
        if not load_ux_flags()["payoff_invited"]:
            mark_ux_flag("payoff_invited")
            lines.append("")
            lines.append(
                "try one: run a task like the ones these came from — the agent"
                " picks the skills up automatically, and you'll see a"
                " ◇ skill used line when it does."
            )
        return "\n".join(lines)

    if action == "skills":
        markers = _distilled_markers()
        usage = _read_usage()
        status = distill_status(runner) or {}
        staged_count = status.get("stagedCount", 0)
        if not markers and not staged_count:
            return "no distilled skills yet — /jinn distill start runs a distillation over your captures"
        lines = ["◇ distilled skills"]
        for name, provenance_count in sorted(markers.items()):
            rec = usage.get(name) if isinstance(usage.get(name), dict) else {}
            count = rec.get("use_count", 0)
            last = rec.get("last_used_at") or "never"
            lines.append(f"  {name}")
            lines.append(f"    used   {count}x · last {last}")
            lines.append(f"    from   {provenance_count} of your captures")
        if staged_count:
            lines.append(f"  staged      {staged_count}  → /jinn distill review")
        return "\n".join(lines)

    if action == "where":
        mode = parts[1] if len(parts) > 1 else ""
        if mode not in ("local", "defer", "off"):
            return "usage: /jinn distill where local|defer|off"
        code, out, err = jinn_layer.run(["distill", "--where", mode, "--json"], runner)
        if code != 0:
            return (err or out).strip() or _update_layer_line()
        cached_mode(runner, refresh=True)
        behaviour = {
            "local": "runs happen here when you start them",
            "defer": "captures keep accruing; nothing runs",
            "off": "captures stop being reserved for distillation",
        }[mode]
        return f"distill mode recorded: {mode} — {behaviour}."

    if action == "":
        status = distill_status(runner)
        if status is None:
            return _update_layer_line()
        cached_mode(runner, refresh=True)
        if status.get("mode") == "unset" and not load_ux_flags()["splash_shown"]:
            mark_ux_flag("splash_shown")
            return render_splash(status)
        return render_hub(status)

    return (
        "/jinn distill — local distillation\n"
        "  /jinn distill                 status (first run: what this is)\n"
        "  /jinn distill start           run one (two-step: start → start confirm)\n"
        "  /jinn distill stop            end the live run (staged skills kept)\n"
        "  /jinn distill review          the staged skills — what each helps with, where it came from\n"
        "  /jinn distill install <name>|all   install staged skills (no re-distillation)\n"
        "  /jinn distill skills          the distilled skillset with usage\n"
        "  /jinn distill where local|defer|off   set where it runs\n"
    )
