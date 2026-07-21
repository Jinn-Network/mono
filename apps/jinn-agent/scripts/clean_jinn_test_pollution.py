#!/usr/bin/env python3
"""Reversibly remove known Jinn test fixtures from the local stores.

Before the store-path sandbox landed, Jinn plugin tests wrote records with
short, hard-coded session IDs into the operator store. This script targets
only those known fixture IDs. It never removes a store directory or an
unrecognized record.

Dry-run by default. ``--yes`` writes a timestamped tarball containing the
selected files (and the pre-edit contribution store), then removes only the
selected fixture records.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tarfile
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple

# Make ``plugins.jinn`` importable — the script lives under
# apps/jinn-agent/scripts/, so its parent is the apps/jinn-agent root that
# holds the ``plugins`` package (same path shim as sample_and_compress.py).
sys.path.insert(0, str(Path(__file__).parent.parent))

from plugins.jinn.distill import episodes_dir  # noqa: E402
from plugins.jinn.session_bridge import contribution_state_dir  # noqa: E402


# These IDs are hard-coded by the Jinn plugin persistence tests that caused
# the observed pollution. Real Hermes sessions use timestamp/random IDs.
KNOWN_FIXTURE_SESSION_IDS = frozenset(
    {"s1", "s2", "sA", "sA1", "sA2", "sB", "session-1"}
)


class UnsafeCleanupPath(RuntimeError):
    """A cleanup path escaped the expected tree or traversed a symlink."""


class CleanupDataError(RuntimeError):
    """A shared store cannot be edited without risking unrelated records."""


class StorePaths(NamedTuple):
    home: Path
    root: Path
    captures: Path
    episodes: Path
    mineable_store: Path


class SelectedFile(NamedTuple):
    """Identity and content observed when a fixture file was selected."""

    path: Path
    device: int
    inode: int
    mode: int
    size: int
    mtime_ns: int
    sha256: str


class CleanupPlan(NamedTuple):
    paths: StorePaths
    selected_files: tuple[SelectedFile, ...]
    mineable_record_ids: tuple[str, ...]
    mineable_before: str | None
    mineable_after: dict[str, Any] | None

    @property
    def files(self) -> tuple[Path, ...]:
        """Paths retained for display and backward-compatible callers."""
        return tuple(selected.path for selected in self.selected_files)


@contextmanager
def _env_unset(name: str):
    """Temporarily remove ``name`` from the environment, then restore it."""
    prior = os.environ.pop(name, None)
    try:
        yield
    finally:
        if prior is not None:
            os.environ[name] = prior


def _default_dir(resolver, env_var: str) -> Path:
    """Resolve a canonical default without honoring a test override."""
    with _env_unset(env_var):
        return Path(resolver()).expanduser()


def legacy_captures_dir() -> Path:
    """Read-only location of the retired CapturedTask tee for cleanup only."""
    configured = (os.environ.get("JINN_LAYER_CAPTURES_DIR") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".jinn-client" / "harness-layer" / "captures"


def _lexical(path: Path) -> Path:
    """Return an absolute lexical path without following symlinks."""
    return Path(os.path.abspath(os.fspath(path.expanduser())))


def store_paths(home: Path | None = None) -> StorePaths:
    """Return the canonical stores beneath ``~/.jinn-client``.

    The production path uses the plugin's own resolvers so the cleanup cannot
    silently drift from the writer. ``home`` exists for hermetic tests.
    """
    selected_home = _lexical(home if home is not None else Path.home())
    root = selected_home / ".jinn-client"
    if home is None:
        captures = _default_dir(legacy_captures_dir, "JINN_LAYER_CAPTURES_DIR")
        episodes = _default_dir(episodes_dir, "JINN_LAYER_EPISODES_DIR")
        mineable = (
            _default_dir(contribution_state_dir, "JINN_MINEABLE_STATE_DIR")
            / "mineable-traces.json"
        )
    else:
        captures = root / "harness-layer" / "captures"
        episodes = root / "harness-layer" / "episodes"
        mineable = root / "mineable" / "mineable-traces.json"
    return StorePaths(
        home=selected_home,
        root=root,
        captures=_lexical(captures),
        episodes=_lexical(episodes),
        mineable_store=_lexical(mineable),
    )


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink():
            raise UnsafeCleanupPath(f"refusing symlink path component: {current}")


def _validate_paths(paths: StorePaths) -> None:
    expected_root = _lexical(paths.home / ".jinn-client")
    root = _lexical(paths.root)
    if root != expected_root:
        raise UnsafeCleanupPath(
            f"cleanup root {root} is not the expected {expected_root}"
        )
    _reject_symlink_components(root)
    for path in (paths.captures, paths.episodes, paths.mineable_store):
        lexical = _lexical(path)
        if lexical == root or root not in lexical.parents:
            raise UnsafeCleanupPath(
                f"cleanup path {lexical} is outside expected root {root}"
            )
        _reject_symlink_components(lexical)


def _fixture_session_id(record: Any) -> str | None:
    if not isinstance(record, dict):
        return None
    session = record.get("session")
    if not isinstance(session, dict):
        return None
    session_id = session.get("sessionId")
    if isinstance(session_id, str) and session_id in KNOWN_FIXTURE_SESSION_IDS:
        return session_id
    return None


def _fixture_episode_ref(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return any(
        value == session_id or value.startswith(f"{session_id}-")
        for session_id in KNOWN_FIXTURE_SESSION_IDS
    )


def _read_regular_file(path: Path) -> tuple[SelectedFile, bytes]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise CleanupDataError(
            f"selected file changed during inspection: {path}"
        ) from exc
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise UnsafeCleanupPath(f"refusing non-regular store entry: {path}")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            content = handle.read()
        after = os.fstat(fd)
    finally:
        os.close(fd)
    observed_before = (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_size,
        before.st_mtime_ns,
    )
    observed_after = (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_size,
        after.st_mtime_ns,
    )
    if observed_before != observed_after or len(content) != after.st_size:
        raise CleanupDataError(f"selected file changed during inspection: {path}")
    return (
        SelectedFile(
            path=path,
            device=after.st_dev,
            inode=after.st_ino,
            mode=after.st_mode,
            size=after.st_size,
            mtime_ns=after.st_mtime_ns,
            sha256=hashlib.sha256(content).hexdigest(),
        ),
        content,
    )


def _fixture_files(directory: Path) -> list[SelectedFile]:
    if not directory.exists():
        return []
    if not directory.is_dir():
        raise UnsafeCleanupPath(f"store path is not a directory: {directory}")

    selected: list[SelectedFile] = []
    for path in sorted(directory.iterdir()):
        if path.is_symlink():
            raise UnsafeCleanupPath(f"refusing symlink store entry: {path}")
        if not path.is_file() or path.suffix != ".json":
            continue
        try:
            evidence, content = _read_regular_file(path)
            record = json.loads(content.decode("utf-8"))
        except (OSError, UnicodeError, ValueError):
            continue
        if _fixture_session_id(record) is not None:
            selected.append(evidence)
    return selected


def _mineable_edit(
    path: Path,
) -> tuple[tuple[str, ...], str | None, dict[str, Any] | None]:
    if not path.exists():
        return (), None, None
    if path.is_symlink() or not path.is_file():
        raise UnsafeCleanupPath(f"refusing non-regular contribution store: {path}")
    try:
        before = path.read_text(encoding="utf-8")
        store = json.loads(before)
    except (OSError, ValueError) as exc:
        raise CleanupDataError(f"cannot safely parse contribution store {path}") from exc
    if (
        not isinstance(store, dict)
        or store.get("schemaVersion")
        not in {"jinn.contribution-store.v2", "jinn.contribution-store.v3"}
        or not isinstance(store.get("records"), dict)
    ):
        raise CleanupDataError(
            f"unsupported contribution store shape at {path}; left unchanged"
        )

    records = store["records"]
    selected = tuple(
        sorted(
            record_id
            for record_id, record in records.items()
            if _fixture_episode_ref(record_id)
            or (
                isinstance(record, dict)
                and _fixture_episode_ref(
                    (record.get("candidate") or {}).get("sourceId")
                    if isinstance(record.get("candidate"), dict)
                    else None
                )
            )
        )
    )
    if not selected:
        return (), None, None
    updated = dict(store)
    updated["records"] = {
        record_id: record
        for record_id, record in records.items()
        if record_id not in selected
    }
    return selected, before, updated


def build_cleanup_plan(paths: StorePaths | None = None) -> CleanupPlan:
    selected_paths = paths if paths is not None else store_paths()
    _validate_paths(selected_paths)
    selected_files = tuple(
        sorted(
            _fixture_files(selected_paths.captures)
            + _fixture_files(selected_paths.episodes),
            key=lambda selected: selected.path,
        )
    )
    record_ids, mineable_before, mineable_after = _mineable_edit(
        selected_paths.mineable_store
    )
    return CleanupPlan(
        paths=selected_paths,
        selected_files=selected_files,
        mineable_record_ids=record_ids,
        mineable_before=mineable_before,
        mineable_after=mineable_after,
    )


def _validate_selected_file(path: Path, paths: StorePaths) -> None:
    lexical = _lexical(path)
    root = _lexical(paths.root)
    if root not in lexical.parents:
        raise UnsafeCleanupPath(f"selected file escaped cleanup root: {lexical}")
    _reject_symlink_components(lexical)
    if path.is_symlink() or not path.is_file():
        raise UnsafeCleanupPath(f"selected path is not a regular file: {path}")


def _validate_selected_snapshot(selected: SelectedFile, paths: StorePaths) -> None:
    _validate_selected_file(selected.path, paths)
    current, _content = _read_regular_file(selected.path)
    if current != selected:
        raise CleanupDataError(
            f"selected file changed after inspection: {selected.path}"
        )


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        indent=2,
        sort_keys=True,
    ) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


@contextmanager
def _private_exclusive_file(path: Path):
    """Create ``path`` as an exclusive 0600 file and remove it on failure."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    created = os.fstat(fd)
    try:
        with os.fdopen(fd, "wb") as handle:
            fd = -1
            try:
                yield handle
            except BaseException:
                # Only unlink the inode this helper created. If the path was
                # replaced concurrently, retain the replacement rather than
                # deleting an unrelated file.
                try:
                    current = os.lstat(path)
                except FileNotFoundError:
                    pass
                else:
                    if (
                        stat.S_ISREG(current.st_mode)
                        and current.st_dev == created.st_dev
                        and current.st_ino == created.st_ino
                    ):
                        path.unlink(missing_ok=True)
                raise
    finally:
        if fd >= 0:
            os.close(fd)


def apply_cleanup(plan: CleanupPlan, backup: Path) -> None:
    """Back up and apply a previously inspected fixture-only plan."""
    _validate_paths(plan.paths)
    backup = _lexical(backup)
    root = _lexical(plan.paths.root)
    if root not in backup.parents:
        raise UnsafeCleanupPath(f"backup path {backup} is outside {root}")
    _reject_symlink_components(backup.parent)
    if os.path.lexists(backup):
        raise UnsafeCleanupPath(f"backup path already exists: {backup}")

    sources = list(plan.files)
    if plan.mineable_after is not None:
        sources.append(plan.paths.mineable_store)
    if not sources:
        return
    for selected in plan.selected_files:
        _validate_selected_snapshot(selected, plan.paths)
    if plan.mineable_after is not None:
        _validate_selected_file(plan.paths.mineable_store, plan.paths)
    if (
        plan.mineable_before is not None
        and plan.paths.mineable_store.read_text(encoding="utf-8")
        != plan.mineable_before
    ):
        raise CleanupDataError(
            "contribution store changed after inspection; rebuild the cleanup plan"
        )

    backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with _private_exclusive_file(backup) as backup_handle:
        with tarfile.open(fileobj=backup_handle, mode="w:gz") as archive:
            for source in sources:
                archive.add(
                    source,
                    arcname=source.relative_to(plan.paths.home),
                    recursive=False,
                )

    for selected in plan.selected_files:
        # Recheck identity and bytes immediately before unlinking. A path that
        # now names legitimate work is retained even if it reused a fixture
        # filename after the operator inspected the plan.
        _validate_selected_snapshot(selected, plan.paths)
        selected.path.unlink()
    if plan.mineable_after is not None:
        _validate_selected_file(plan.paths.mineable_store, plan.paths)
        if (
            plan.mineable_before is None
            or plan.paths.mineable_store.read_text(encoding="utf-8")
            != plan.mineable_before
        ):
            raise CleanupDataError(
                "contribution store changed during cleanup; left it unchanged"
            )
        _write_json_atomic(plan.paths.mineable_store, plan.mineable_after)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="back up and remove only recognized fixture records (default: dry-run)",
    )
    args = parser.parse_args()

    try:
        plan = build_cleanup_plan()
    except (CleanupDataError, UnsafeCleanupPath) as exc:
        print(f"Refusing cleanup: {exc}", file=sys.stderr)
        return 2

    if not plan.files and not plan.mineable_record_ids:
        print("No known Jinn test fixture records found — nothing to clean.")
        return 0

    print("Known Jinn test fixture records found:")
    for path in plan.files:
        print(f"  file: {path}")
    for record_id in plan.mineable_record_ids:
        print(f"  contribution record: {record_id}")

    if not args.yes:
        print("\nDry-run (no --yes): nothing changed.")
        print("Re-run with --yes to back up and remove only the records above.")
        return 0

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = plan.paths.root / f".pollution-backup-{timestamp}.tgz"
    try:
        apply_cleanup(plan, backup)
    except (CleanupDataError, UnsafeCleanupPath, OSError, tarfile.TarError) as exc:
        print(f"Cleanup failed safely: {exc}", file=sys.stderr)
        return 2

    print(f"\nBacked up selected records to {backup}")
    print(f"Removed {len(plan.files)} fixture file(s)")
    print(f"Removed {len(plan.mineable_record_ids)} fixture contribution record(s)")
    print(f"Undo immediately with: tar -xzf {backup} -C {plan.paths.home}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
