"""Read-only repository evidence and ContributionCandidateV1 assembly."""

from __future__ import annotations

import subprocess
from pathlib import Path

from plugins.jinn import session_bridge


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=repo, text=True, capture_output=True, check=True
    )
    return proc.stdout


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "remote", "add", "origin", "git@github.com:Jinn-Network/example.git")
    (repo / "base.txt").write_text("base\n", encoding="utf-8")
    _git(repo, "add", "base.txt")
    _git(repo, "commit", "-qm", "base")
    return repo


def test_snapshot_and_accepted_diff_cover_every_change_without_mutation(tmp_path):
    repo = _repo(tmp_path)
    snapshot = session_bridge.snapshot_repository("session-1", cwd=repo)
    assert snapshot is not None
    assert snapshot.repository_slug == "Jinn-Network/example"

    (repo / "committed.txt").write_text("committed since start\n", encoding="utf-8")
    _git(repo, "add", "committed.txt")
    _git(repo, "commit", "-qm", "during session")
    (repo / "staged.txt").write_text("staged change\n", encoding="utf-8")
    _git(repo, "add", "staged.txt")
    (repo / "base.txt").write_text("unstaged change\n", encoding="utf-8")
    (repo / "untracked.txt").write_text("untracked change\n", encoding="utf-8")

    before_status = _git(repo, "status", "--porcelain=v1", "--untracked-files=all")
    before_index = _git(repo, "ls-files", "--stage")

    diff = session_bridge.accepted_diff(snapshot)

    assert "committed since start" in diff
    assert "staged change" in diff
    assert "unstaged change" in diff
    assert "untracked change" in diff
    assert _git(repo, "status", "--porcelain=v1", "--untracked-files=all") == before_status
    assert _git(repo, "ls-files", "--stage") == before_index


def test_test_run_is_structured_only_when_command_and_exit_are_reliable():
    run = session_bridge.test_run_from_tool_call(
        "terminal",
        {"command": "scripts/run_tests.sh tests/plugins/test_jinn_plugin.py -q"},
        {"exit_code": 1, "output": "1 failed"},
        "1784073600000000000",
    )
    assert run == {
        "command": "scripts/run_tests.sh tests/plugins/test_jinn_plugin.py -q",
        "exitCode": 1,
        "at": "2026-07-15T00:00:00Z",
    }
    assert session_bridge.test_run_from_tool_call(
        "terminal", {"command": "echo done"}, {"exit_code": 0}, "1784073600000000000"
    ) is None
    assert session_bridge.test_run_from_tool_call(
        "terminal", {"command": "yarn test"}, "unstructured output", "1784073600000000000"
    ) is None


def test_candidate_uses_the_fixed_v1_names_and_required_empty_arrays(tmp_path):
    repo = _repo(tmp_path)
    snapshot = session_bridge.snapshot_repository("session-1", cwd=repo)
    assert snapshot is not None
    (repo / "fix.py").write_text("print('fixed')\n", encoding="utf-8")
    diff = session_bridge.accepted_diff(snapshot)
    episode = {
        "episodeId": "episode-1",
        "session": {"sessionId": "session-1", "capturedAt": "2026-07-15T00:00:00Z"},
    }

    candidate = session_bridge.build_contribution_candidate(
        episode,
        snapshot,
        accepted=diff,
        test_runs=[],
        intermediate_failure_diffs=[],
        skill_refs=["systematic-debugging", "tdd"],
        publish_consent=True,
        created_at="2026-07-15T01:00:00Z",
    )

    assert candidate == {
        "schemaVersion": "jinn.contribution-candidate.v1",
        "sourceId": "episode-1",
        "repositorySlug": "Jinn-Network/example",
        "baseCommit": snapshot.base_head,
        "acceptedDiff": diff,
        "testRuns": [],
        "intermediateFailureDiffs": [],
        "skillEvents": [
            {"skillRef": "systematic-debugging", "action": "loaded"},
            {"skillRef": "tdd", "action": "loaded"},
        ],
        "publishMinedTasksConsent": True,
        "createdAt": "2026-07-15T01:00:00Z",
    }


def test_candidate_is_omitted_without_a_repository_or_an_accepted_diff(tmp_path):
    repo = _repo(tmp_path)
    snapshot = session_bridge.snapshot_repository("session-1", cwd=repo)
    assert snapshot is not None
    episode = {"session": {"sessionId": "session-1"}}

    assert session_bridge.build_contribution_candidate(
        episode,
        snapshot,
        accepted="",
        test_runs=[],
        intermediate_failure_diffs=[],
        skill_refs=[],
        publish_consent=False,
        created_at="2026-07-15T01:00:00Z",
    ) is None
