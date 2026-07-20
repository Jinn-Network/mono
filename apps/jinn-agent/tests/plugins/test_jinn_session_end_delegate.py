"""Complete EpisodeV1 delegation and canonical-write ownership."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
buf = importlib.import_module("plugins.jinn.capture_buffer")
consent = importlib.import_module("plugins.jinn.consent")


def _response(
    *,
    outer: str = "ok",
    persistence: str = "ok",
    episode_id: str | None = "episode-1",
    contribution: dict | None = None,
) -> str:
    persisted: dict = {"status": persistence}
    if persistence != "ok":
        persisted["reason"] = "persistence detail"
    if episode_id is not None:
        persisted["value"] = {"episodeId": episode_id}
    value = {
        "episodeRef": "episode-1",
        "persistence": persisted,
        "eligibility": {
            "eligible": True,
            "reason": "accepted diff",
            "checkedAt": "2026-07-15T00:00:00Z",
        },
        "summary": {
            "episodeRef": "episode-1",
            "searchedTerms": [],
            "providedPackets": [],
            "eligibility": {
                "eligible": True,
                "reason": "accepted diff",
                "checkedAt": "2026-07-15T00:00:00Z",
            },
            "nothingFound": True,
        },
    }
    if contribution is not None:
        value["contribution"] = contribution
    envelope = {"contractVersion": 1, "status": outer, "value": value}
    if outer != "ok":
        envelope["reason"] = "product detail"
    return json.dumps(envelope)


class SessionRunner:
    def __init__(self, code: int = 0, output: str | None = None) -> None:
        self.code = code
        self.output = output
        self.calls: list[tuple[list[str], str | None]] = []

    def __call__(self, argv: list[str], *, input: str | None = None) -> tuple[int, str]:
        self.calls.append((argv, input))
        if self.output is not None:
            return self.code, self.output
        request = json.loads(input or "{}")
        episode_id = (request.get("episode") or {}).get("episodeId", "episode-1")
        return self.code, _response(episode_id=episode_id)


def _episode(episode_id: str = "episode-1") -> dict:
    return {
        "schemaVersion": "jinn.episode.v1",
        "episodeId": episode_id,
        "session": {"sessionId": "s1", "capturedAt": "2026-07-15T00:00:00Z"},
        "task": {"summary": "fix tests", "distributionTags": []},
        "trajectory": [
            {
                "spanId": "turn-1",
                "parentSpanId": None,
                "kind": "jinn.agent_turn",
                "name": "turn:user",
                "startTimeUnixNano": "1",
                "endTimeUnixNano": "1",
                "attributes": {"role": "user", "turn.text": "fix tests"},
                "redactedKeys": [],
            }
        ],
        "environment": {
            "harness": {"name": "jinn-agent", "version": "1"},
            "model": "m",
            "tools": [],
            "skillsLoadout": [],
        },
        "outcome": {"status": "completed", "verificationStrength": "user-accepted"},
        "cost": {"durationMs": 1},
        "retention": {"policy": "contribution-eligible"},
        "provenance": "contributed",
    }


@pytest.fixture(autouse=True)
def reset(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    buf.reset()
    jinn._reset_session_state()
    jinn._degraded = None
    jinn._runner = None

    def _no_real_subprocess(argv, cwd=None, input=None, timeout_s=None):
        # mono#1783: with jinn._runner unset, _on_session_end falls through
        # to distill.cached_mode -> jinn_layer._default_runner, which
        # genuinely shells out (up to a 120s timeout) to a real jinn-layer
        # binary on PATH against the operator's actual ~/.jinn-client state.
        # No test in this file may ever reach a real subprocess; individual
        # tests that need a specific _default_runner behavior override this
        # via their own monkeypatch.setattr, which layers on top.
        return 127, "", "jinn-layer disabled by test fixture"

    monkeypatch.setattr(jinn.jinn_layer, "_default_runner", _no_real_subprocess)
    jinn.distill.reset()
    yield
    jinn._runner = None
    buf.reset()


def test_delegate_posts_the_complete_episode_activity_eligibility_and_candidate():
    runner = SessionRunner()
    jinn._runner = runner
    episode = _episode()
    candidate = {
        "schemaVersion": "jinn.contribution-candidate.v1",
        "sourceId": "episode-1",
        "repositorySlug": "Jinn-Network/mono",
        "baseCommit": "a" * 40,
        "acceptedDiff": "diff --git a/x b/x\n",
        "testRuns": [],
        "intermediateFailureDiffs": [],
        "skillEvents": [],
        "publishMinedTasksConsent": True,
        "createdAt": "2026-07-15T00:00:00Z",
    }

    result = jinn._delegate_session_end(
        episode,
        activity={
            "searchedTerms": ["dashboard", "vitest"],
            "providedRefs": ["ref-a"],
            "surfacedRefs": ["ref-a"],
            "fetchedRefs": ["ref-a"],
        },
        eligibility_inputs={"acceptedDiff": True},
        contribution_candidate=candidate,
        contribution_vetoed=False,
    )

    assert result is not None
    request = json.loads(runner.calls[0][1])
    assert request == {
        "contractVersion": 1,
        "episode": episode,
        "activity": {
            "retrievalFired": False,
            "eligibleRefs": [],
            "deliveredRefs": [],
            "deliveryMode": "disabled",
            "searchedTerms": ["dashboard", "vitest"],
            "providedRefs": ["ref-a"],
            "surfacedRefs": ["ref-a"],
            "fetchedRefs": ["ref-a"],
            "installedSkillRefs": [],
        },
        "eligibilityInputs": {"acceptedDiff": True},
        "contributionCandidate": candidate,
        "contributionVetoed": False,
    }
    assert request["episode"] == episode
    assert request["episode"]["outcome"]["verificationStrength"] == "user-accepted"
    assert "verifiabilityTier" not in request["episode"]["outcome"]


def test_delegate_parses_normally_when_stderr_carries_a_warning(monkeypatch):
    """mono#1787: a stderr diagnostic on the real subprocess path (e.g. the
    harness's "skipping malformed legacy capture" warning) must never
    corrupt a structurally valid stdout v1 envelope."""
    episode = _episode()

    def fake_default_runner(argv, cwd=None, input=None, timeout_s=jinn.jinn_layer._TIMEOUT_S):
        request = json.loads(input or "{}")
        episode_id = (request.get("episode") or {}).get("episodeId", "episode-1")
        return (
            0,
            _response(episode_id=episode_id),
            "[evidence] skipping malformed legacy capture "
            "s1-1784122564637021000.json: some warning",
        )

    monkeypatch.setattr(jinn.jinn_layer, "_default_runner", fake_default_runner)
    jinn._runner = None

    result = jinn._delegate_session_end(
        episode, activity={}, eligibility_inputs={}, contribution_candidate=None,
        contribution_vetoed=False,
    )

    assert result is not None
    assert result["persistence"]["value"]["episodeId"] == "episode-1"


def test_degraded_contribution_does_not_duplicate_successfully_persisted_episode():
    jinn._runner = SessionRunner(
        output=_response(
            outer="degraded",
            persistence="degraded",
            contribution={"status": "unavailable", "reason": "sidecar absent"},
        )
    )

    result = jinn._delegate_session_end(
        _episode(), activity={}, eligibility_inputs={}, contribution_candidate=None,
        contribution_vetoed=False,
    )

    assert result is not None
    assert result["persistence"]["value"]["episodeId"] == "episode-1"


@pytest.mark.parametrize(
    ("code", "output"),
    [
        (1, "process failed"),
        (0, "not json"),
        (0, '{"contractVersion":2,"status":"ok","value":{}}'),
        (0, '{"contractVersion":1,"status":"unavailable","reason":"store absent"}'),
        (0, _response(persistence="unavailable", episode_id=None)),
        (0, _response(persistence="degraded", episode_id=None)),
        (0, _response(episode_id="different-episode")),
    ],
)
def test_delegate_requires_canonical_persistence_of_the_same_episode(code, output):
    jinn._runner = SessionRunner(code=code, output=output)

    assert jinn._delegate_session_end(
        _episode(), activity={}, eligibility_inputs={}, contribution_candidate=None,
        contribution_vetoed=False,
    ) is None


def test_vetoed_hook_sends_candidate_and_clears_marker_only_after_veto_receipt(monkeypatch):
    candidate = {
        "schemaVersion": "jinn.contribution-candidate.v1",
        "sourceId": "filled-by-test",
    }
    monkeypatch.setattr(
        jinn.session_bridge,
        "build_contribution_candidate",
        lambda *_a, **_k: candidate,
    )
    monkeypatch.setattr(jinn.distill, "tee_capture", lambda *_a, **_k: None)
    delegated: list[dict] = []

    def delegate(episode, **kwargs):
        delegated.append(kwargs)
        return {
            "persistence": {"status": "ok", "value": {"episodeId": episode["episodeId"]}},
            "contribution": {
                "status": "ok",
                "value": {"recordId": episode["episodeId"], "status": "vetoed"},
            },
        }

    monkeypatch.setattr(jinn, "_delegate_session_end", delegate)
    jinn._record_veto("s1")

    _drive_hook()

    assert delegated[0]["contribution_candidate"] is candidate
    assert delegated[0]["contribution_vetoed"] is True
    assert jinn._session_vetoed("s1") is False


def test_no_real_subprocess_is_ever_spawned_by_this_file(monkeypatch):
    """mono#1783: `_on_session_end` with `jinn._runner = None` used to fall
    through to `distill.cached_mode(None)` -> `jinn_layer._default_runner`,
    which genuinely shells out to an installed `jinn-layer` binary (up to a
    120s timeout) against the operator's real ~/.jinn-client state. The
    `reset` fixture now monkeypatches `_default_runner` itself so this path
    is unreachable; assert that guarantee directly by recording every
    `subprocess.run` invocation. Fast local `git` calls (session_bridge's
    repository snapshot) are legitimate; anything else — i.e. a real
    `jinn-layer` spawn — is the regression. The guard both raises (so the
    slow binary never actually executes) and records (because
    `distill.distill_status` swallows runner exceptions, a raise alone would
    vanish on exactly the path that flakes)."""
    import subprocess as subprocess_module

    real_run = subprocess_module.run
    non_git_spawns: list[str] = []

    def guard(argv, *args, **kwargs):
        cmd = argv[0] if isinstance(argv, (list, tuple)) else argv
        if Path(str(cmd)).name == "git":
            return real_run(argv, *args, **kwargs)
        non_git_spawns.append(str(cmd))
        raise AssertionError(
            "real subprocess.run was invoked — the jinn_layer._default_runner "
            "seam is not closed (mono#1783 regression)"
        )

    monkeypatch.setattr(subprocess_module, "run", guard)

    candidate = {
        "schemaVersion": "jinn.contribution-candidate.v1",
        "sourceId": "filled-by-test",
    }
    monkeypatch.setattr(
        jinn.session_bridge, "build_contribution_candidate", lambda *_a, **_k: candidate
    )
    monkeypatch.setattr(jinn.distill, "tee_capture", lambda *_a, **_k: None)
    jinn._runner = None  # deliberately unset, exercising the real-runner path

    _drive_hook()  # must never reach subprocess.run with a non-git command

    assert non_git_spawns == [], (
        f"real subprocess(es) spawned: {non_git_spawns} — the "
        "jinn_layer._default_runner seam is not closed (mono#1783 regression)"
    )


def _drive_hook() -> None:
    jinn._on_pre_llm_call(
        session_id="s1", task_id="t1", user_message="fix tests", model="m", is_first_turn=False
    )
    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "scripts/run_tests.sh tests/plugins/test_jinn_plugin.py"},
        result={"exit_code": 0},
        session_id="s1",
        task_id="t1",
        tool_call_id="c1",
    )
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True)


def test_hook_falls_back_once_on_process_failure_and_preserves_episode(monkeypatch):
    jinn._runner = SessionRunner(code=1, output="boom")
    local: list[dict] = []
    monkeypatch.setattr(jinn.distill, "write_episode_fallback", lambda episode: local.append(episode))
    monkeypatch.setattr(jinn.distill, "tee_capture", lambda *_a, **_k: None)

    _drive_hook()
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True)

    assert len(local) == 1
    assert local[0]["episodeId"]
    assert local[0]["provenance"] == "contributed"
    assert local[0]["outcome"]["verificationStrength"] == "user-accepted"
    assert "verifiabilityTier" not in local[0]["outcome"]
    assert [s["kind"] for s in local[0]["trajectory"]] == ["jinn.agent_turn", "jinn.tool_call"]


def test_hook_does_not_write_python_episode_when_core_persisted(monkeypatch):
    jinn._runner = SessionRunner()
    local: list[dict] = []
    monkeypatch.setattr(jinn.distill, "write_episode_fallback", lambda episode: local.append(episode))
    monkeypatch.setattr(jinn.distill, "tee_capture", lambda *_a, **_k: None)

    _drive_hook()

    assert local == []


def test_old_pending_files_are_preserved_and_never_auto_published(tmp_path, monkeypatch):
    pending = tmp_path / "jinn" / "pending"
    pending.mkdir(parents=True)
    old = pending / "old-session.json"
    old.write_text('{"legacy":true}\n', encoding="utf-8")
    consent.save_state(True, previewed=True)
    runner = SessionRunner()
    jinn._runner = runner
    monkeypatch.setattr(jinn.distill, "tee_capture", lambda *_a, **_k: None)

    _drive_hook()

    assert old.read_text(encoding="utf-8") == '{"legacy":true}\n'
    assert all(call[0][1] != "publish" for call in runner.calls)
