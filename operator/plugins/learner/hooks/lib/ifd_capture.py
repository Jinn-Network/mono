"""Intermediate-failure-diff capture helpers for the learner Claude Code hook (#2230)."""
from __future__ import annotations

import json
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any, Optional

SHELL_TOOLS = {"Bash", "bash", "Shell", "shell", "terminal"}
TEST_EXECUTABLES = {"pytest", "tox", "jest", "vitest", "run_tests.sh"}
PKG_TEST_FIRST = {"yarn", "npm", "pnpm", "bun", "cargo", "go", "make"}


def is_test_command(command: str) -> bool:
    try:
        words = shlex.split(command)
    except ValueError:
        return False
    if not words:
        return False
    first = Path(words[0]).name
    if first in TEST_EXECUTABLES:
        return True
    if any(Path(w).name == "run_tests.sh" for w in words):
        return True
    return len(words) >= 2 and first in PKG_TEST_FIRST and words[1] == "test"


def _exit_code_from_response(result: Any) -> Optional[int]:
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


_STATUS_CODE_RE = re.compile(r"status code\s+(\d+)", re.IGNORECASE)


def exit_code_from_payload(payload: dict) -> Optional[int]:
    """Return an exit code when the payload represents a completed shell tool outcome.

    PostToolUseFailure: the event itself means failure (unless is_interrupt).
    PostToolUse: only when tool_response carries an explicit numeric exit code.
    """
    event = payload.get("hook_event_name") or payload.get("hookEventName")
    if payload.get("is_interrupt") is True or payload.get("isInterrupt") is True:
        return None
    tool_response = payload.get("tool_response")
    if tool_response is None:
        tool_response = payload.get("toolResponse")
    resp_code = _exit_code_from_response(tool_response)
    if resp_code is not None:
        return resp_code
    if event in ("PostToolUseFailure", "PostToolUseFailed"):
        err = payload.get("error")
        if isinstance(err, str):
            m = _STATUS_CODE_RE.search(err)
            if m:
                return int(m.group(1))
        return 1
    return None


def _git(repo: Path, args: list[str], *, accepted_codes: tuple[int, ...] = (0,)) -> str:
    proc = subprocess.run(
        ["git", "-c", "core.quotepath=false", *args],
        cwd=str(repo),
        capture_output=True,
        check=False,
    )
    if proc.returncode not in accepted_codes:
        return ""
    return proc.stdout.decode("utf-8", errors="replace")


def accepted_diff(repo_root: Path, base_head: str) -> str:
    tracked = _git(
        repo_root,
        ["diff", "--binary", "--no-ext-diff", base_head, "--"],
    )
    untracked_raw = _git(
        repo_root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
    )
    pieces = [tracked] if tracked else []
    for name in (part for part in untracked_raw.split("\0") if part):
        patch = _git(
            repo_root,
            ["diff", "--no-index", "--binary", "--", "/dev/null", name],
            accepted_codes=(0, 1),
        )
        if patch:
            pieces.append(patch)
    return "".join(pieces)


def ensure_session_base(working_dir: Path, repo_root: Path) -> Optional[str]:
    if not (repo_root / ".git").exists():
        return None
    execute = working_dir / ".execute"
    execute.mkdir(parents=True, exist_ok=True)
    base_file = execute / "session-repo-base"
    if base_file.is_file():
        sha = base_file.read_text(encoding="utf-8").strip()
        if sha:
            return sha
    head = _git(repo_root, ["rev-parse", "HEAD"]).strip()
    if not head:
        return None
    base_file.write_text(head + "\n", encoding="utf-8")
    return head


def append_failure_diff(working_dir: Path, diff: str) -> None:
    if not diff:
        return
    execute = working_dir / ".execute"
    execute.mkdir(parents=True, exist_ok=True)
    path = execute / "intermediate-failure-diffs.json"
    arr: list[str] = []
    if path.is_file():
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(parsed, list):
                arr = [x for x in parsed if isinstance(x, str)]
        except (OSError, json.JSONDecodeError):
            arr = []
    if diff in arr:
        return
    arr.append(diff)
    path.write_text(json.dumps(arr), encoding="utf-8")


def handle_hook_payload(payload: dict, working_dir: Path) -> None:
    tool = payload.get("tool_name") or payload.get("toolName") or ""
    if tool not in SHELL_TOOLS:
        return
    # Stage 1: lazy-pin session base on the first shell hook that sees repo/.git,
    # including success / non-test Bash — not only the first failed test. Otherwise
    # commits between explore and the first failure silently move the baseline.
    repo_root = working_dir / "repo"
    base = ensure_session_base(working_dir, repo_root)
    tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
    if not isinstance(tool_input, dict):
        return
    command = tool_input.get("command", tool_input.get("cmd"))
    if not isinstance(command, str) or not is_test_command(command):
        return
    code = exit_code_from_payload(payload)
    if code is None or code == 0:
        return
    if base is None:
        base = ensure_session_base(working_dir, repo_root)
    if base is None:
        return
    diff = accepted_diff(repo_root, base)
    append_failure_diff(working_dir, diff)
