"""Jinn plugin tests — local capture plus the versioned process bridge.

Local capture is unconditional.  At session end the plugin delegates one
complete EpisodeV1 to ``jinn-layer session end``; it never creates, publishes,
or automatically drains the retired raw pending-task queue.
"""

from __future__ import annotations

import importlib
import hashlib
import json
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
consent = importlib.import_module("plugins.jinn.consent")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")
session_bridge = importlib.import_module("plugins.jinn.session_bridge")
jinn_layer = importlib.import_module("plugins.jinn.jinn_layer")
skill_provenance = importlib.import_module("tools.skill_provenance")


class RunnerSpy:
    """Records every invocation and canonically persists session-end input."""

    def __init__(self, code: int = 0, out: str = "ok"):
        self.calls: list[list[str]] = []
        self.inputs: list[str | None] = []
        self.code = code
        self.out = out
        self.contribution: dict | None = None

    def __call__(self, argv: list[str], *, input: str | None = None) -> tuple[int, str]:
        self.calls.append(argv)
        self.inputs.append(input)
        if self.code == 0 and self.out == "ok" and argv[1:3] == ["session", "end"]:
            request = json.loads(input or "{}")
            episode_id = request["episode"]["episodeId"]
            eligibility = {
                "eligible": False,
                "reason": "test fixture",
                "checkedAt": "2026-07-15T00:00:00Z",
            }
            value = {
                "episodeRef": episode_id,
                "persistence": {"status": "ok", "value": {"episodeId": episode_id}},
                "eligibility": eligibility,
                "summary": {
                    "episodeRef": episode_id,
                    "searchedTerms": [],
                    "providedPackets": [],
                    "eligibility": eligibility,
                    "nothingFound": True,
                },
            }
            if self.contribution is not None:
                value["contribution"] = self.contribution
            return 0, json.dumps({"contractVersion": 1, "status": "ok", "value": value})
        return self.code, self.out


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("JINN_CLI_NAME", "jinn-agent")
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path / "episodes"))
    monkeypatch.setenv("JINN_MINEABLE_STATE_DIR", str(tmp_path / "mineable"))
    capture_buffer.reset()
    jinn._reset_session_state()
    jinn._degraded = None
    jinn._vetoed_tasks.clear()
    snapshot = session_bridge.RepositorySnapshot(
        session_id="s1",
        root=tmp_path,
        origin="https://github.com/Jinn-Network/example.git",
        repository_slug="Jinn-Network/example",
        base_head="0123456789abcdef",
    )
    monkeypatch.setattr(
        session_bridge,
        "snapshot_repository",
        lambda session_id, cwd=None: snapshot,
    )
    monkeypatch.setattr(
        session_bridge,
        "accepted_diff",
        lambda repository_snapshot: "diff --git a/example.py b/example.py\n+fixed\n",
    )
    spy = RunnerSpy()
    jinn._runner = spy
    yield spy
    jinn._runner = None


def _start_session(session_id: str = "s1", task_id: str = "t1"):
    jinn._on_pre_llm_call(
        session_id=session_id,
        task_id=task_id,
        user_message="Fix the failing test suite",
        is_first_turn=True,
        model="test-model",
        platform="cli",
    )
    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "yarn test"},
        session_id=session_id,
        task_id=task_id,
        tool_call_id="call-1",
        result='{"output": "1 failed"}',
        duration_ms=50,
    )


def _run_session(session_id: str = "s1", task_id: str = "t1", completed: bool = True):
    _start_session(session_id=session_id, task_id=task_id)
    jinn._on_session_end(
        session_id=session_id, task_id=task_id, completed=completed, interrupted=False
    )


def _write_calls(spy: RunnerSpy) -> list[list[str]]:
    """Contribution-side calls only (publish/capture). Pickup's read-only
    corpus calls are allowed regardless of consent — consuming is ungated."""
    return [c for c in spy.calls if len(c) > 1 and c[1] in ("publish", "capture")]


def _pending_files(tmp_home: Path) -> list[Path]:
    d = tmp_home / "jinn" / "pending"
    return sorted(d.glob("*.json")) if d.exists() else []


def _session_requests(spy: RunnerSpy) -> list[dict]:
    return [
        json.loads(input)
        for call, input in zip(spy.calls, spy.inputs)
        if call[1:3] == ["session", "end"] and input is not None
    ]


# ── Local capture and process delegation ─────────────────────────────────────

def test_unset_consent_never_uses_legacy_raw_publication(isolated_home, tmp_path):
    _run_session()
    assert _write_calls(isolated_home) == []
    assert _pending_files(tmp_path) == []
    assert _session_requests(isolated_home)[0]["contributionVetoed"] is False


def test_declined_consent_never_uses_legacy_raw_publication(isolated_home, tmp_path):
    consent.save_state(False)
    _run_session()
    assert _write_calls(isolated_home) == []
    assert _pending_files(tmp_path) == []
    assert _session_requests(isolated_home)[0]["contributionCandidate"][
        "publishMinedTasksConsent"
    ] is False


def test_retained_stage1_share_consent_cannot_authorize_stage2_candidate(
    isolated_home, tmp_path, monkeypatch
):
    # Fork behaviour: bin/jinn-agent exports JINN_HARNESS_NAME=jinn-agent.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    consent.save_state(True)
    _run_session()
    assert _write_calls(isolated_home) == []
    assert _pending_files(tmp_path) == []
    request = _session_requests(isolated_home)[0]
    episode = request["episode"]
    assert episode["schemaVersion"] == "jinn.episode.v1"
    assert episode["retention"]["policy"] == "local-private"
    assert episode["provenance"] == "contributed"
    assert request["contributionCandidate"]["publishMinedTasksConsent"] is False
    assert episode["outcome"] == {
        "status": "completed",
        "verificationStrength": "user-accepted",
        "acceptedDiff": True,
        "testRuns": {"passed": 0, "failed": 0},
    }
    assert episode["task"]["summary"] == "Fix the failing test suite"
    assert episode["environment"]["harness"]["name"] == "jinn-agent"
    assert episode["trajectory"][1]["name"] == "tool:terminal"


def test_session_start_quarantines_existing_publication_state_even_with_retained_consent(
    isolated_home, tmp_path
):
    consent.save_state(True, previewed=True)

    jinn._on_session_start(session_id="s1", platform="cli")

    assert (tmp_path / "mineable" / session_bridge.PUBLICATION_DISABLED_FILE).is_file()
    assert any(call[1:3] == ["contribution", "disable"] for call in isolated_home.calls)


def test_preview_state_does_not_restore_legacy_publish(isolated_home, tmp_path):
    consent.save_state(True, previewed=True)
    _run_session()
    assert _write_calls(isolated_home) == []
    assert _pending_files(tmp_path) == []
    assert len(_session_requests(isolated_home)) == 1


def test_summary_and_model_captured_when_not_flagged_first_turn(isolated_home, tmp_path):
    """mono #1404: capture must not hinge solely on is_first_turn.

    On the Nous/OpenAI-compat path a completed session published with
    summary "(no summary)" / model "unknown". record_first_turn must run
    regardless of the is_first_turn flag so the trace keeps its metadata.
    """
    consent.save_state(True)
    jinn._on_pre_llm_call(
        session_id="s1",
        task_id="t1",
        user_message="Search the web for X",
        is_first_turn=False,  # the failing path
        model="step-3.7-flash",
        platform="cli",
    )
    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "ls"},
        session_id="s1",
        task_id="t1",
        tool_call_id="c1",
        result='{"output": "ok"}',
        duration_ms=10,
    )
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True, interrupted=False)
    episode = _session_requests(isolated_home)[0]["episode"]
    assert episode["task"]["summary"] == "Search the web for X"
    assert episode["environment"]["model"] == "step-3.7-flash"


def test_background_review_is_linked_isolated_and_never_creates_a_candidate(isolated_home):
    _start_session(session_id="parent", task_id="parent-task")

    token = skill_provenance.set_current_write_origin(
        skill_provenance.BACKGROUND_REVIEW
    )
    try:
        _run_session(session_id="parent", task_id="review-task")
    finally:
        skill_provenance.reset_current_write_origin(token)

    jinn._on_session_end(
        session_id="parent",
        task_id="parent-task",
        completed=True,
        interrupted=False,
    )

    requests = _session_requests(isolated_home)
    assert len(requests) == 2
    child = next(
        request for request in requests
        if request["episode"]["session"]["kind"] == "host-internal"
    )
    parent = next(
        request for request in requests
        if request["episode"]["session"]["kind"] == "user"
    )
    assert child["episode"]["session"]["parentSessionId"] == "parent"
    assert child["episode"]["session"]["sessionId"] != parent["episode"]["session"]["sessionId"]
    assert child["episode"]["episodeId"] != parent["episode"]["episodeId"]
    assert "contributionCandidate" not in child
    assert parent["contributionCandidate"]["sourceId"] == parent["episode"]["episodeId"]


def test_episode_persists_repository_diff_and_test_run_observables(isolated_home):
    jinn._on_pre_llm_call(
        session_id="s1",
        task_id="t1",
        user_message="Fix the failing test suite",
        is_first_turn=False,
        model="test-model",
    )
    for call_id, exit_code in (("passing", 0), ("failing", 1)):
        jinn._on_post_tool_call(
            tool_name="terminal",
            args={"command": "yarn test"},
            session_id="s1",
            task_id="t1",
            tool_call_id=call_id,
            result={"exit_code": exit_code, "output": "done"},
            duration_ms=1,
        )
    jinn._on_session_end(
        session_id="s1", task_id="t1", completed=True, interrupted=False
    )

    episode = _session_requests(isolated_home)[0]["episode"]
    assert episode["task"]["repositorySlug"] == "Jinn-Network/example"
    assert episode["task"]["baseCommit"] == "0123456789abcdef"
    assert episode["outcome"]["acceptedDiff"] is True
    assert episode["outcome"]["testRuns"] == {"passed": 1, "failed": 1}


def test_repository_pickup_probe_preserves_session_start_snapshot_for_accepted_diff(
    isolated_home, tmp_path, monkeypatch
):
    state = jinn._state_for("s1")
    session_start_snapshot = state["snapshot"]
    first_cwd = tmp_path / "first"
    second_cwd = tmp_path / "second"
    first_cwd.mkdir()
    second_cwd.mkdir()

    def probe_snapshot(session_id, cwd=None):
        resolved = Path(cwd).resolve()
        slug = "acme/first" if resolved == first_cwd.resolve() else "acme/second"
        return session_bridge.RepositorySnapshot(
            session_id=session_id,
            root=resolved,
            origin=f"https://github.com/{slug}.git",
            repository_slug=slug,
            base_head="probe-head",
        )

    accepted_snapshots = []
    monkeypatch.setattr(session_bridge, "snapshot_repository", probe_snapshot)
    monkeypatch.setattr(
        session_bridge,
        "accepted_diff",
        lambda snapshot: accepted_snapshots.append(snapshot) or "accepted diff",
    )

    jinn._on_pre_llm_call(
        session_id="s1",
        task_id="t1",
        user_message="Fix the first repository",
        is_first_turn=True,
        cwd=str(first_cwd),
    )
    jinn._on_pre_llm_call(
        session_id="s1",
        task_id="t1",
        user_message="Continue in the second repository",
        is_first_turn=False,
        cwd=str(second_cwd),
    )
    jinn._on_session_end(
        session_id="s1",
        task_id="t1",
        completed=True,
        interrupted=False,
    )

    assert accepted_snapshots == [session_start_snapshot]
    request = _session_requests(isolated_home)[0]
    assert request["episode"]["task"]["repositorySlug"] == (
        session_start_snapshot.repository_slug
    )
    assert request["episode"]["task"]["baseCommit"] == session_start_snapshot.base_head


def test_episode_retains_exact_delivery_hash_and_refs_without_injected_bytes(
    isolated_home, monkeypatch
):
    context = "[jinn corpus] exact private delivery bytes"

    def fake_pickup(_message, **kwargs):
        activity = kwargs["activity"]
        activity.update({
            "retrievalFired": True,
            "eligibleRefs": ["bafy-eligible"],
            "deliveredRefs": ["bafy-delivered"],
            "deliveryMode": "delivered",
            "deliveredContentHash": (
                "sha256:" + hashlib.sha256(context.encode("utf-8")).hexdigest()
            ),
            "searchedTerms": ["delivery"],
            "providedRefs": ["bafy-delivered"],
        })
        return jinn.pickup.PickupOutcome(context={"context": context})

    monkeypatch.setattr(jinn.pickup, "pickup_with_outcome", fake_pickup)
    _run_session()

    request = _session_requests(isolated_home)[0]
    assert request["episode"]["activity"] == request["activity"]
    assert request["episode"]["activity"]["deliveredContentHash"] == (
        "sha256:" + hashlib.sha256(context.encode("utf-8")).hexdigest()
    )
    assert request["episode"]["activity"]["deliveredRefs"] == ["bafy-delivered"]
    assert context not in json.dumps(request)


def test_veto_records_locally_and_never_publishes_content(isolated_home, tmp_path):
    consent.save_state(True, previewed=True)
    # Veto is issued mid-session, once the task under capture has steps.
    _start_session()
    out = jinn._handle_jinn(command_args="veto", session_id="s1", task_id="t1")
    assert "Session s1 is vetoed" in out
    assert "already published is immutable" in out
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True, interrupted=False)
    request = _session_requests(isolated_home)[0]
    assert request["contributionVetoed"] is True
    assert request["contributionCandidate"]["sourceId"] == request["episode"]["episodeId"]
    assert _write_calls(isolated_home) == []


def test_veto_with_no_active_task_reports_nothing_to_veto(isolated_home):
    # mono issue #1383 — /jinn veto with nothing under capture must not
    # return the success copy (it was an in-memory no-op).
    consent.save_state(True, previewed=True)
    out = jinn._handle_jinn(command_args="veto", session_id="s1", task_id="t1")
    assert out == (
        "No active task to veto — veto marks the task currently running in this session."
    )
    assert not jinn._vetoed_tasks


def test_process_failure_persists_episode_fallback_without_pending_file(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    capture_buffer.reset()
    consent.save_state(True, previewed=True)
    failing = RunnerSpy(code=1, out="anchor tx reverted")
    jinn._runner = failing
    try:
        _run_session()
    finally:
        jinn._runner = None
    assert _write_calls(failing) == []
    assert _pending_files(tmp_path) == []
    episodes = sorted((tmp_path / "episodes").glob("*.json"))
    assert len(episodes) == 1
    assert json.loads(episodes[0].read_text())["schemaVersion"] == "jinn.episode.v1"
    err = capsys.readouterr().err
    assert "Saved this session locally" in err
    assert "local learning pending" not in err
    assert "eligibility unavailable" not in err
    assert "contribution unavailable" not in err


def test_abandoned_session_is_marked_abandoned(isolated_home, tmp_path):
    consent.save_state(True)
    jinn._on_pre_llm_call(
        session_id="s2", task_id="t2", user_message="x", is_first_turn=True, model="m"
    )
    jinn._on_post_tool_call(
        tool_name="terminal", args={}, session_id="s2", task_id="t2",
        tool_call_id="c", result="", duration_ms=1,
    )
    jinn._on_session_end(session_id="s2", task_id="t2", completed=False, interrupted=True)
    episode = _session_requests(isolated_home)[0]["episode"]
    assert episode["outcome"]["status"] == "abandoned"


# ── Retired pending files ────────────────────────────────────────────────────

def test_existing_pending_files_are_preserved_and_never_auto_drained(isolated_home, tmp_path):
    pending = tmp_path / "jinn" / "pending"
    pending.mkdir(parents=True)
    first = pending / "old-a.json"
    second = pending / "old-b.json"
    first.write_text('{"legacy":1}\n')
    second.write_text('{"legacy":2}\n')

    consent.save_state(True, previewed=True)
    _run_session(session_id="sB", task_id="tB")

    assert first.read_text() == '{"legacy":1}\n'
    assert second.read_text() == '{"legacy":2}\n'
    assert _write_calls(isolated_home) == []


# ── Session-end feedback ─────────────────────────────────────────────────────

def test_session_end_published_outcome_says_contribution_is_immutable(
    isolated_home, capsys
):
    consent.save_state(True, previewed=True)
    isolated_home.contribution = {
        "status": "ok",
        "value": {"recordId": "episode-1", "status": "published"},
    }
    _run_session()
    err = capsys.readouterr().err
    assert "jinn: contribution published — immutable" in err


def test_session_end_without_corpus_result_prints_complete_summary(isolated_home, capsys):
    _run_session()
    err = capsys.readouterr().err
    assert "Jinn" in err
    assert "no relevant prior notes found" in err.lower()
    assert "Saved this session for next time" in err
    assert "episode captured" not in err
    assert "local learning pending" not in err
    assert "contribution unavailable" not in err


# ── Consent flow ─────────────────────────────────────────────────────────────

def test_consent_flow_bare_enter_defaults_to_decline(isolated_home):
    # explainer -> decline confirm. The single sharing question — no second,
    # unrelated question follows it.
    answers = iter(["", "y"])
    printed: list[str] = []
    share = consent.run_consent_flow(lambda _: next(answers), printed.append)
    assert share is False
    assert consent.share_enabled() is False


def test_consent_flow_accept_requires_deliberate_confirm(isolated_home):
    # accept -> back out -> accept -> confirm
    answers = iter(["a", "n", "a", "y"])
    printed: list[str] = []
    share = consent.run_consent_flow(lambda _: next(answers), printed.append)
    assert share is True
    assert consent.share_enabled() is True


def test_consent_state_survives_reload(isolated_home):
    consent.save_state(True)
    assert consent.load_state()["shareConsent"] is True
    consent.mark_previewed()
    state = consent.load_state()
    assert state["previewed"] is True
    assert state["shareConsent"] is True


# ── Slash surface ────────────────────────────────────────────────────────────

def test_status_reports_contribution_parked_and_no_sharing_lines(isolated_home):
    out = jinn._handle_jinn(command_args="status")
    assert "contribution: parked — nothing leaves this machine" in out
    # The removed outbound surface leaves no sharing/preview/pending lines.
    assert "sharing:" not in out
    assert "previewed:" not in out
    assert "pending trace:" not in out


def test_removed_surfaces_fall_through_to_help(isolated_home):
    # consent / preview / ledger are deleted verbs: they no longer dispatch a
    # branch and fall through to the help text (no outbound call is made).
    for verb in ("consent", "preview", "ledger"):
        out = jinn._handle_jinn(command_args=verb)
        assert "/jinn — Jinn layer" in out
    assert isolated_home.calls == []


def test_jinn_layer_not_found_points_at_plugin_update():
    """The jinn-layer bin arrives with the plugin; a missing bin names the
    `jinn-agent plugins update jinn` refresh (mono#1818) and the JINN_LAYER_BIN
    override. The diagnostic lives on stderr (stdout/stderr reported
    separately)."""
    code, out, err = jinn_layer._default_runner(["definitely-not-a-real-binary-xyz"])
    assert code == 127
    assert out == ""
    assert "jinn-agent plugins update jinn" in err
    assert "JINN_LAYER_BIN" in err
