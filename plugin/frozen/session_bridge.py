"""Read-only host evidence for the versioned Jinn session bridge."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.parse import urlparse


PUBLICATION_DISABLED_FILE = "publication-disabled"


def contribution_state_dir() -> Path:
    configured = (os.environ.get("JINN_MINEABLE_STATE_DIR") or "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".jinn-client" / "mineable"


def set_publication_enabled(enabled: bool) -> bool:
    """Fail-closed host fallback for the shared publication preference."""
    directory = contribution_state_dir()
    marker = directory / PUBLICATION_DISABLED_FILE
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
        if enabled:
            marker.unlink(missing_ok=True)
        else:
            tmp = directory / f".{PUBLICATION_DISABLED_FILE}.{os.getpid()}.tmp"
            try:
                with tmp.open("w", encoding="utf-8") as handle:
                    handle.write("disabled\n")
                os.chmod(tmp, 0o600)
                os.replace(tmp, marker)
                os.chmod(marker, 0o600)
            finally:
                tmp.unlink(missing_ok=True)
        return True
    except OSError:
        return False


@dataclass(frozen=True)
class RepositorySnapshot:
    session_id: str
    root: Path
    origin: Optional[str]
    repository_slug: Optional[str]
    base_head: str


def _git(root: Path, args: list[str], *, accepted_codes: tuple[int, ...] = (0,)) -> str:
    env = dict(os.environ)
    # These commands are observations. Suppress Git's optional index refresh
    # so even metadata remains unchanged while a session is being measured.
    env["GIT_OPTIONAL_LOCKS"] = "0"
    proc = subprocess.run(
        ["git", *args],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in accepted_codes:
        raise RuntimeError(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc.stdout


def _repository_slug(origin: str) -> Optional[str]:
    value = origin.strip()
    if not value:
        return None
    if ":" in value and "://" not in value:
        value = value.split(":", 1)[1]
    elif "://" in value:
        value = urlparse(value).path
    value = value.strip("/")
    if value.endswith(".git"):
        value = value[:-4]
    parts = [part for part in value.split("/") if part]
    return "/".join(parts[-2:]) if len(parts) >= 2 else None


def snapshot_repository(session_id: str, cwd: Optional[Path] = None) -> Optional[RepositorySnapshot]:
    """Snapshot repo identity at session start without modifying Git state."""
    start = Path(cwd or Path.cwd()).resolve()
    try:
        root = Path(_git(start, ["rev-parse", "--show-toplevel"]).strip()).resolve()
        head = _git(root, ["rev-parse", "HEAD"]).strip()
        try:
            origin = _git(root, ["remote", "get-url", "origin"]).strip() or None
        except RuntimeError:
            origin = None
    except (OSError, RuntimeError):
        return None
    return RepositorySnapshot(
        session_id=session_id,
        root=root,
        origin=origin,
        repository_slug=_repository_slug(origin or ""),
        base_head=head,
    )


def accepted_diff(snapshot: RepositorySnapshot) -> str:
    """Final tracked+untracked patch relative to the session-start HEAD.

    ``git diff <base>`` folds committed-since-start, staged, and unstaged
    tracked changes into one patch. Untracked files are appended with
    ``--no-index``; unlike ``git add -N``, this never mutates the index.
    """
    tracked = _git(
        snapshot.root,
        ["-c", "core.quotepath=false", "diff", "--binary", "--no-ext-diff", snapshot.base_head, "--"],
    )
    untracked_raw = _git(
        snapshot.root,
        ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    )
    pieces = [tracked] if tracked else []
    for name in (part for part in untracked_raw.split("\0") if part):
        patch = _git(
            snapshot.root,
            ["-c", "core.quotepath=false", "diff", "--no-index", "--binary", "--", "/dev/null", name],
            accepted_codes=(0, 1),
        )
        if patch:
            pieces.append(patch)
    return "".join(pieces)


def _exit_code(result: Any) -> Optional[int]:
    value = result
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return None
    if not isinstance(value, dict):
        return None
    for key in ("exit_code", "exitCode", "returncode"):
        code = value.get(key)
        if isinstance(code, int) and not isinstance(code, bool):
            return code
    return None


def _is_test_command(command: str) -> bool:
    try:
        words = shlex.split(command)
    except ValueError:
        return False
    if not words:
        return False
    executables = {"pytest", "tox", "jest", "vitest"}
    first = Path(words[0]).name
    if first in executables or first == "run_tests.sh":
        return True
    if any(Path(word).name == "run_tests.sh" for word in words):
        return True
    return len(words) >= 2 and first in {"yarn", "npm", "pnpm", "bun", "cargo", "go", "make"} and words[1] == "test"


def test_run_from_tool_call(
    tool_name: str,
    args: Any,
    result: Any,
    end_time_unix_nano: str,
) -> Optional[Dict[str, Any]]:
    """Project a terminal test call only when command and exit are explicit."""
    if tool_name not in ("terminal", "shell", "bash") or not isinstance(args, dict):
        return None
    command = args.get("command", args.get("cmd"))
    code = _exit_code(result)
    if not isinstance(command, str) or not _is_test_command(command) or code is None:
        return None
    try:
        at = datetime.fromtimestamp(int(end_time_unix_nano) / 1_000_000_000, timezone.utc)
    except (TypeError, ValueError, OSError):
        return None
    return {
        "command": command,
        "exitCode": code,
        "at": at.isoformat(timespec="seconds").replace("+00:00", "Z"),
    }


def build_contribution_candidate(
    episode: Dict[str, Any],
    snapshot: Optional[RepositorySnapshot],
    *,
    accepted: str,
    test_runs: list[Dict[str, Any]],
    intermediate_failure_diffs: list[str],
    skill_refs: Iterable[str],
    publish_consent: bool,
    created_at: str,
) -> Optional[Dict[str, Any]]:
    """Build the fixed ContributionCandidateV1 only from honest repo facts."""
    if snapshot is None or not snapshot.repository_slug or not accepted:
        return None
    source_id = episode.get("episodeId") if isinstance(episode, dict) else None
    if not isinstance(source_id, str) or not source_id:
        return None
    unique_skills = list(dict.fromkeys(ref for ref in skill_refs if isinstance(ref, str) and ref))
    return {
        "schemaVersion": "jinn.contribution-candidate.v1",
        "sourceId": source_id,
        "repositorySlug": snapshot.repository_slug,
        "baseCommit": snapshot.base_head,
        "acceptedDiff": accepted,
        "testRuns": list(test_runs),
        "intermediateFailureDiffs": list(intermediate_failure_diffs),
        "skillEvents": [{"skillRef": ref, "action": "loaded"} for ref in unique_skills],
        "publishMinedTasksConsent": bool(publish_consent),
        "createdAt": created_at,
    }
