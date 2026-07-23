"""Evidence-first auto-pickup tests (Stage 1 rescope R3, closes mono #1732).

The policy under test lives in `packages/plugin` now (rescope R1) — pickup.py
is a thin delegation to `jinn-layer session pickup`. These tests cover the
delegation itself: request shape, verbatim contextBlock rendering, activity
recording, the evidence signal line, and every fail-open path (missing
binary, malformed response, contract mismatch, disabled config, a stale
layer whose response predates the `packets` field).
"""

from __future__ import annotations

import json
import importlib
import hashlib
import threading
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
pickup = importlib.import_module("plugins.jinn.pickup")
jinn_layer = importlib.import_module("plugins.jinn.jinn_layer")

MSG = "The client dashboard vitest suite is flaky again — the update_available check races the version status fetch"

CONTEXT_BLOCK = (
    "[jinn corpus] Prior evidence relevant to this task:\n"
    "Fix the dashboard flake · completed/tests-passed\n"
    "- failure: FAIL version-status.test.ts\n"
    "  source: bafySourceEpisode · operator-recorded-session · captured 2026-07-04 · "
    "full episode: corpus_fetch bafySourceEpisode"
)


def ok_response(**value_overrides) -> str:
    value = {
        "contextBlock": CONTEXT_BLOCK,
        "packets": [{"ref": "bafySourceEpisode"}],
        "searchedTerms": ["dashboard", "vitest", "update_available"],
        "eligibleRefs": ["bafySourceEpisode"],
        "deliveredRefs": ["bafySourceEpisode"],
        "deliveredCanonicalEpisodeIds": ["episode-dashboard-fix"],
        "deliveryMode": "delivered",
        **value_overrides,
    }
    return json.dumps({"contractVersion": 1, "status": "ok", "value": value})


class PickupRunner:
    """Serves `jinn-layer session pickup` with one canned response."""

    def __init__(self, code: int = 0, out: str = "", raw_value: dict | None = None):
        self.code = code
        self.out = out or ok_response()
        self.calls: list[tuple[list[str], str | None]] = []
        if raw_value is not None:
            self.out = json.dumps({"contractVersion": 1, "status": "ok", "value": raw_value})

    def __call__(self, argv: list[str], *, input: str | None = None) -> tuple[int, str]:
        self.calls.append((argv, input))
        return self.code, self.out


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    jinn._reset_session_state()
    yield tmp_path
    jinn._reset_session_state()


# ── Delegation ────────────────────────────────────────────────────────────────

def test_pickup_delegates_to_session_pickup_with_the_v1_request_shape():
    runner = PickupRunner()
    pickup.pickup(MSG, runner=runner, session_id="s1", model="claude-test", repository_slug="acme/widget")

    assert len(runner.calls) == 1
    argv, raw_input = runner.calls[0]
    assert argv == [jinn_layer.binary(), "session", "pickup"]
    request = json.loads(raw_input)
    assert request["contractVersion"] == jinn_layer.CONTRACT_VERSION
    assert request["firstMessage"] == MSG
    assert request["meta"]["sessionId"] == "s1"
    assert request["meta"]["model"] == "claude-test"
    assert request["meta"]["repositorySlug"] == "acme/widget"
    assert request["meta"]["harness"]["name"]
    assert isinstance(request["meta"]["taskSummary"], str) and request["meta"]["taskSummary"]
    assert request["meta"]["tools"] == []


def test_pickup_omits_repository_slug_when_unknown():
    runner = PickupRunner()
    pickup.pickup(MSG, runner=runner, session_id="s1")
    request = json.loads(runner.calls[0][1])
    assert "repositorySlug" not in request["meta"]


def test_pickup_sends_canonical_exclusions_and_returns_delivered_ids():
    runner = PickupRunner()

    outcome = pickup.pickup_with_outcome(
        MSG,
        runner=runner,
        exclude_canonical_episode_ids=["episode-old"],
    )

    request = json.loads(runner.calls[0][1])
    assert request["excludeCanonicalEpisodeIds"] == ["episode-old"]
    assert outcome.delivered_canonical_episode_ids == (
        "episode-dashboard-fix",
    )


def test_pickup_filters_malformed_canonical_request_and_response_ids():
    runner = PickupRunner(out=ok_response(
        deliveredCanonicalEpisodeIds=[
            "episode-dashboard-fix",
            "",
            None,
            42,
            "episode-follow-up",
        ],
    ))

    outcome = pickup.pickup_with_outcome(
        MSG,
        runner=runner,
        exclude_canonical_episode_ids=[
            "episode-old",
            "",
            None,
            42,
            "episode-older",
        ],
    )

    request = json.loads(runner.calls[0][1])
    assert request["excludeCanonicalEpisodeIds"] == [
        "episode-old",
        "episode-older",
    ]
    assert outcome.delivered_canonical_episode_ids == (
        "episode-dashboard-fix",
        "episode-follow-up",
    )


def test_legacy_pickup_api_still_returns_only_context():
    runner = PickupRunner()

    result = pickup.pickup(
        MSG,
        runner=runner,
        exclude_canonical_episode_ids=["episode-old"],
    )

    assert result == {"context": CONTEXT_BLOCK}


def test_pickup_renders_the_context_block_verbatim():
    runner = PickupRunner()
    result = pickup.pickup(MSG, runner=runner)
    assert result == {"context": CONTEXT_BLOCK}


def test_pickup_consumes_successful_packets_from_a_degraded_partial_response():
    response = json.loads(ok_response())
    response["status"] = "degraded"
    response["reason"] = "one near-miss unavailable"
    runner = PickupRunner(out=json.dumps(response))
    activity: dict = {}

    result = pickup.pickup(MSG, runner=runner, activity=activity)

    assert result == {"context": CONTEXT_BLOCK}
    assert activity["providedRefs"] == ["bafySourceEpisode"]


def test_pickup_returns_none_when_nothing_is_provided():
    runner = PickupRunner(out=ok_response(contextBlock=None, packets=[]))
    activity: dict = {}
    assert pickup.pickup(MSG, runner=runner, activity=activity) is None
    assert activity["deliveredRefs"] == []
    assert activity["deliveryMode"] == "withheld"
    assert "deliveredContentHash" not in activity


def test_pickup_returns_none_when_context_block_is_blank():
    runner = PickupRunner(out=ok_response(contextBlock="   "))
    activity: dict = {}
    assert pickup.pickup(MSG, runner=runner, activity=activity) is None
    assert activity["deliveredRefs"] == []
    assert activity["deliveryMode"] == "withheld"
    assert "deliveredContentHash" not in activity


# ── Activity recording (rescope §3.6) ───────────────────────────────────────

def test_pickup_records_searched_terms_and_provided_refs():
    runner = PickupRunner()
    activity = {"searchedTerms": [], "providedRefs": [], "surfacedRefs": [], "fetchedRefs": []}

    pickup.pickup(MSG, runner=runner, activity=activity)

    assert activity["searchedTerms"] == ["dashboard", "vitest", "update_available"]
    assert activity["providedRefs"] == ["bafySourceEpisode"]
    assert activity["retrievalFired"] is True
    assert activity["eligibleRefs"] == ["bafySourceEpisode"]
    assert activity["deliveredRefs"] == ["bafySourceEpisode"]
    assert activity["deliveryMode"] == "delivered"
    assert activity["deliveredContentHash"] == (
        "sha256:" + hashlib.sha256(CONTEXT_BLOCK.encode("utf-8")).hexdigest()
    )
    # Internal fetch-attempt fields are untouched by pickup itself.
    assert activity["surfacedRefs"] == []
    assert activity["fetchedRefs"] == []


def test_pickup_records_searched_terms_even_when_nothing_is_provided():
    # Honest legibility: a search that found nothing still records what was
    # searched — only the injection (and the derived nothing-found summary
    # line) omits the terms.
    runner = PickupRunner(out=ok_response(contextBlock=None, packets=[], searchedTerms=["quasar", "unobtainium"]))
    activity: dict = {}

    pickup.pickup(MSG, runner=runner, activity=activity)

    assert activity["searchedTerms"] == ["quasar", "unobtainium"]
    assert activity["providedRefs"] == []


def test_pickup_surfaces_a_fired_but_degraded_retrieval_when_the_call_fails():
    runner = PickupRunner(code=1, out="boom")
    activity = {"searchedTerms": ["stale"], "providedRefs": ["stale-ref"]}

    pickup.pickup(MSG, runner=runner, activity=activity)

    assert activity == {
        "searchedTerms": ["stale"],
        "providedRefs": ["stale-ref"],
        "retrievalFired": True,
        "deliveryMode": "degraded",
    }


# ── The evidence signal line (rescope §3.4) ─────────────────────────────────

def test_pickup_emits_exactly_one_evidence_signal_when_provided():
    runner = PickupRunner()
    lines: list[str] = []

    result = pickup.pickup(MSG, runner=runner, signal_sink=lines.append)

    assert result is not None
    assert len(lines) == 1
    assert "◇ corpus" in lines[0]
    assert "provided" in lines[0]
    assert "dashboard" in lines[0]


def test_pickup_emits_no_signal_when_nothing_is_provided():
    runner = PickupRunner(out=ok_response(contextBlock=None, packets=[]))
    lines: list[str] = []

    pickup.pickup(MSG, runner=runner, signal_sink=lines.append)

    assert lines == []


def test_pickup_default_signal_sink_prints_the_marker_byte_plain(monkeypatch, capsys):
    # mono #1798: the default sink (used whenever the host doesn't override
    # signal_sink, i.e. the real TUI path) must strip ANSI before printing —
    # prompt_toolkit's patch_stdout proxy renders raw ESC bytes as `?` noise
    # rather than colour. Force the exact palette the live bug report showed.
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.setenv("COLUMNS", "120")
    runner = PickupRunner()

    result = pickup.pickup(MSG, runner=runner)

    assert result is not None
    err = capsys.readouterr().err
    assert "\x1b" not in err
    assert "◇ corpus" in err
    assert "provided 1 evidence packet" in err
    assert "dashboard" in err


# ── Fail-open paths ──────────────────────────────────────────────────────────

def test_pickup_fails_open_on_broken_layer():
    def broken(argv, **_kw):
        raise RuntimeError("boom")
    assert pickup.pickup(MSG, runner=broken) is None


def test_pickup_fails_open_on_missing_binary():
    runner = PickupRunner(code=127, out="jinn-layer: not found")
    assert pickup.pickup(MSG, runner=runner) is None


def test_pickup_fails_open_on_malformed_json():
    runner = PickupRunner(out="not json")
    assert pickup.pickup(MSG, runner=runner) is None


def test_pickup_fails_open_on_contract_version_mismatch():
    runner = PickupRunner(out=json.dumps({"contractVersion": 2, "status": "ok", "value": {}}))
    assert pickup.pickup(MSG, runner=runner) is None


def test_pickup_returns_none_on_unavailable_status():
    runner = PickupRunner(out=json.dumps({
        "contractVersion": 1, "status": "unavailable", "reason": "jinn-layer unreachable",
    }))
    assert pickup.pickup(MSG, runner=runner) is None


# ── Stream separation (mono #1787) ──────────────────────────────────────────

def test_pickup_parses_normally_when_stderr_carries_a_warning(monkeypatch):
    """A stderr diagnostic on the real subprocess path (e.g. the harness's
    "skipping malformed legacy capture" warning) must never corrupt a
    structurally valid stdout v1 envelope."""
    def fake_default_runner(argv, cwd=None, input=None, timeout_s=jinn_layer._SESSION_PICKUP_TIMEOUT_S):
        return (
            0,
            ok_response(),
            "[evidence] skipping malformed legacy capture "
            "s1-1784122564637021000.json: some warning",
        )

    monkeypatch.setattr(jinn_layer, "_default_runner", fake_default_runner)

    result = pickup.pickup(MSG, runner=None)

    assert result == {"context": CONTEXT_BLOCK}


def test_stale_layer_response_without_packets_is_treated_as_degraded_nothing():
    """A v1 response without `packets` (a stale jinn-layer predating the
    rescope) must never reintroduce the old suggestion/install shape via
    contextBlock — treated as degraded-nothing (R3 AC)."""
    runner = PickupRunner(out=json.dumps({
        "contractVersion": 1,
        "status": "ok",
        "value": {
            # Old shape: no "packets" key, but still carries a contextBlock —
            # must not be rendered.
            "contextBlock": "[jinn corpus] Relevant to this task:\n- old skill suggestion",
            "suggestions": ["- old skill suggestion"],
        },
    }))
    activity: dict = {}

    result = pickup.pickup(MSG, runner=runner, activity=activity)

    assert result is None
    assert activity == {"retrievalFired": True, "deliveryMode": "degraded"}


def test_disabled_config_is_a_no_op(tmp_path):
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"enabled": False}))
    runner = PickupRunner()
    assert pickup.pickup(MSG, runner=runner) is None
    assert runner.calls == []


def test_load_config_defaults_to_enabled_when_absent(tmp_path):
    assert pickup.load_config() == {"enabled": True}


def test_load_config_ignores_unreadable_file(tmp_path):
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text("not json")
    assert pickup.load_config() == {"enabled": True}


# ── Hook wiring ──────────────────────────────────────────────────────────────

def test_hook_returns_pickup_context_on_first_turn():
    runner = PickupRunner()
    jinn._runner = runner
    try:
        result = jinn._on_pre_llm_call(
            session_id="s1", task_id="t1", user_message=MSG, is_first_turn=True, model="m",
        )
    finally:
        jinn._runner = None
    assert result is not None and "context" in result
    assert jinn._on_pre_llm_call(session_id="s1", user_message=MSG, is_first_turn=False) is None


def test_same_task_and_repository_only_pick_up_once():
    runner = PickupRunner()
    jinn._runner = runner
    try:
        first = jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t1",
            user_message=MSG,
            is_first_turn=True,
        )
        second = jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t1",
            user_message=MSG,
            is_first_turn=False,
        )
    finally:
        jinn._runner = None

    assert first == {"context": CONTEXT_BLOCK}
    assert second is None
    assert len(runner.calls) == 1


def test_changed_non_empty_task_id_triggers_pickup_again():
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t1",
            user_message=MSG,
            is_first_turn=True,
        )
        result = jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t2",
            user_message="Fix the next dashboard failure",
            is_first_turn=False,
        )
    finally:
        jinn._runner = None

    assert result == {"context": CONTEXT_BLOCK}
    assert len(runner.calls) == 2


def test_changed_repository_triggers_pickup_again(tmp_path, monkeypatch):
    first_cwd = tmp_path / "first"
    second_cwd = tmp_path / "second"
    first_cwd.mkdir()
    second_cwd.mkdir()

    def snapshot_repository(session_id, cwd=None):
        resolved = Path(cwd).resolve() if cwd is not None else tmp_path.resolve()
        slug = (
            "acme/first"
            if resolved == first_cwd.resolve()
            else "acme/second"
            if resolved == second_cwd.resolve()
            else "acme/session-start"
        )
        return jinn.session_bridge.RepositorySnapshot(
            session_id=session_id,
            root=resolved,
            origin=f"https://github.com/{slug}.git",
            repository_slug=slug,
            base_head="0123456789abcdef",
        )

    monkeypatch.setattr(jinn.session_bridge, "snapshot_repository", snapshot_repository)
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id="s1",
            task_id="",
            user_message=MSG,
            is_first_turn=True,
            cwd=str(first_cwd),
        )
        result = jinn._on_pre_llm_call(
            session_id="s1",
            task_id="",
            user_message="Continue in the second repository",
            is_first_turn=False,
            cwd=str(second_cwd),
        )
    finally:
        jinn._runner = None

    assert result == {"context": CONTEXT_BLOCK}
    assert len(runner.calls) == 2
    requests = [json.loads(raw_input) for _, raw_input in runner.calls]
    assert requests[0]["meta"]["repositorySlug"] == "acme/first"
    assert requests[1]["meta"]["repositorySlug"] == "acme/second"


def test_repository_probe_failure_fails_open_with_unknown_identity(
    tmp_path, monkeypatch
):
    jinn._state_for("s1")
    supplied_cwd = tmp_path / "unreadable-repository"
    supplied_cwd.mkdir()

    def broken_probe(session_id, cwd=None):
        raise ValueError("invalid repository cwd")

    monkeypatch.setattr(jinn.session_bridge, "snapshot_repository", broken_probe)
    runner = PickupRunner()
    jinn._runner = runner
    try:
        result = jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t1",
            user_message=MSG,
            is_first_turn=True,
            cwd=str(supplied_cwd),
        )
    finally:
        jinn._runner = None

    assert result == {"context": CONTEXT_BLOCK}
    request = json.loads(runner.calls[0][1])
    assert "repositorySlug" not in request["meta"]
    checkpoint = jinn._peek_state("s1")["pickupCheckpoint"]
    assert checkpoint["hasRun"] is True
    assert checkpoint["repositorySlug"] is None
    assert checkpoint["repositoryCwd"] is None


def test_failed_repository_transition_does_not_repeat_or_poison_retry(
    tmp_path, monkeypatch
):
    session_id = "probe-retry-session"
    jinn._state_for(session_id)
    first_cwd = tmp_path / "first"
    second_cwd = tmp_path / "second"
    first_cwd.mkdir()
    second_cwd.mkdir()
    fail_second_probe = True
    probed_cwds = []

    def snapshot_repository(probe_session_id, cwd=None):
        nonlocal fail_second_probe
        resolved = Path(cwd).resolve()
        probed_cwds.append(resolved)
        if resolved == second_cwd.resolve() and fail_second_probe:
            raise ValueError("transient repository probe failure")
        slug = (
            "acme/first"
            if resolved == first_cwd.resolve()
            else "acme/second"
        )
        return jinn.session_bridge.RepositorySnapshot(
            session_id=probe_session_id,
            root=resolved,
            origin=f"https://github.com/{slug}.git",
            repository_slug=slug,
            base_head="0123456789abcdef",
        )

    monkeypatch.setattr(
        jinn.session_bridge,
        "snapshot_repository",
        snapshot_repository,
    )
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="stable-task",
            user_message=MSG,
            is_first_turn=True,
            cwd=str(first_cwd),
        )
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="stable-task",
            user_message="Continue after a transient probe failure",
            is_first_turn=False,
            cwd=str(second_cwd),
        )

        assert len(runner.calls) == 1
        checkpoint_after_failure = jinn._peek_state(session_id)[
            "pickupCheckpoint"
        ]
        assert checkpoint_after_failure["repositorySlug"] == "acme/first"
        assert checkpoint_after_failure["repositoryCwd"] == str(
            first_cwd.resolve()
        )

        fail_second_probe = False
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="stable-task",
            user_message="Continue after the repository probe recovers",
            is_first_turn=False,
            cwd=str(second_cwd),
        )
    finally:
        jinn._runner = None

    assert probed_cwds.count(second_cwd.resolve()) == 2
    assert len(runner.calls) == 2
    second_request = json.loads(runner.calls[1][1])
    assert second_request["meta"]["repositorySlug"] == "acme/second"
    assert second_request["excludeCanonicalEpisodeIds"] == [
        "episode-dashboard-fix",
    ]


def test_unknown_repository_transition_does_not_repeat_or_poison_retry(
    tmp_path, monkeypatch
):
    session_id = "unknown-probe-retry-session"
    jinn._state_for(session_id)
    first_cwd = tmp_path / "first"
    second_cwd = tmp_path / "second"
    first_cwd.mkdir()
    second_cwd.mkdir()
    second_slug_is_unknown = True
    probed_cwds = []

    def snapshot_repository(probe_session_id, cwd=None):
        resolved = Path(cwd).resolve()
        probed_cwds.append(resolved)
        if resolved == second_cwd.resolve() and second_slug_is_unknown:
            slug = None
            origin = None
        else:
            slug = (
                "acme/first"
                if resolved == first_cwd.resolve()
                else "acme/second"
            )
            origin = f"https://github.com/{slug}.git"
        return jinn.session_bridge.RepositorySnapshot(
            session_id=probe_session_id,
            root=resolved,
            origin=origin,
            repository_slug=slug,
            base_head="0123456789abcdef",
        )

    monkeypatch.setattr(
        jinn.session_bridge,
        "snapshot_repository",
        snapshot_repository,
    )
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="stable-task",
            user_message=MSG,
            is_first_turn=True,
            cwd=str(first_cwd),
        )
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="stable-task",
            user_message="Continue while repository identity is unknown",
            is_first_turn=False,
            cwd=str(second_cwd),
        )

        assert len(runner.calls) == 1
        checkpoint_after_unknown = jinn._peek_state(session_id)[
            "pickupCheckpoint"
        ]
        assert checkpoint_after_unknown["repositorySlug"] == "acme/first"
        assert checkpoint_after_unknown["repositoryCwd"] == str(
            first_cwd.resolve()
        )

        second_slug_is_unknown = False
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="stable-task",
            user_message="Continue after repository identity recovers",
            is_first_turn=False,
            cwd=str(second_cwd),
        )
    finally:
        jinn._runner = None

    assert probed_cwds.count(second_cwd.resolve()) == 2
    assert len(runner.calls) == 2
    second_request = json.loads(runner.calls[1][1])
    assert second_request["meta"]["repositorySlug"] == "acme/second"


def test_missing_stable_task_id_stays_first_turn_only():
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id="s1",
            task_id="",
            user_message=MSG,
            is_first_turn=True,
        )
        result = jinn._on_pre_llm_call(
            session_id="s1",
            task_id="   ",
            user_message="A later model iteration",
            is_first_turn=False,
        )
    finally:
        jinn._runner = None

    assert result is None
    assert len(runner.calls) == 1


def test_repeat_pickup_sends_ids_delivered_by_the_prior_pickup():
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t1",
            user_message=MSG,
            is_first_turn=True,
        )
        runner.out = ok_response(
            deliveredCanonicalEpisodeIds=["episode-follow-up"],
        )
        jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t2",
            user_message="Fix the follow-up failure",
            is_first_turn=False,
        )
    finally:
        jinn._runner = None

    second_request = json.loads(runner.calls[1][1])
    assert second_request["excludeCanonicalEpisodeIds"] == [
        "episode-dashboard-fix",
    ]
    checkpoint = jinn._peek_state("s1")["pickupCheckpoint"]
    assert checkpoint["deliveredCanonicalEpisodeIds"] == [
        "episode-dashboard-fix",
        "episode-follow-up",
    ]


def test_checkpoint_and_exclusions_survive_real_per_turn_session_end():
    runner = PickupRunner()
    session_id = "lifecycle-session"
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="turn-task-1",
            user_message=MSG,
            is_first_turn=True,
        )
        first_state = jinn._state_for(session_id)
        jinn._on_session_end(
            session_id=session_id,
            task_id="turn-task-1",
            completed=True,
            interrupted=False,
        )
        assert session_id not in jinn._session_states

        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="turn-task-2",
            user_message="Fix the next real user turn",
            is_first_turn=False,
        )
        second_state = jinn._state_for(session_id)
    finally:
        jinn._runner = None

    pickup_requests = [
        json.loads(raw_input)
        for argv, raw_input in runner.calls
        if argv[1:3] == ["session", "pickup"]
    ]
    session_end_request = next(
        json.loads(raw_input)
        for argv, raw_input in runner.calls
        if argv[1:3] == ["session", "end"]
    )
    assert len(pickup_requests) == 2
    assert pickup_requests[1]["excludeCanonicalEpisodeIds"] == [
        "episode-dashboard-fix",
    ]
    assert second_state is not first_state
    assert "deliveredCanonicalEpisodeIds" not in second_state["activity"]
    assert "pickupCheckpoint" not in session_end_request
    assert "deliveredCanonicalEpisodeIds" not in session_end_request["activity"]


def test_session_finalize_clears_persistent_pickup_checkpoint():
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id="finalized-session",
            task_id="turn-task-1",
            user_message=MSG,
            is_first_turn=True,
        )
    finally:
        jinn._runner = None

    assert jinn._peek_state("finalized-session")["pickupCheckpoint"]["hasRun"]
    jinn._on_session_finalize(
        session_id="finalized-session",
        reason="shutdown",
    )
    assert not jinn._peek_state("finalized-session")["pickupCheckpoint"]["hasRun"]


def test_failed_pickup_advances_checkpoint_instead_of_retrying_each_iteration():
    runner = PickupRunner(code=1, out="boom")
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t1",
            user_message=MSG,
            is_first_turn=True,
        )
        jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t1",
            user_message="A later model iteration",
            is_first_turn=False,
        )
    finally:
        jinn._runner = None

    assert len(runner.calls) == 1


def test_concurrent_same_checkpoint_does_not_duplicate_or_hold_state_lock():
    started = threading.Event()
    release = threading.Event()
    second_finished = threading.Event()
    calls = 0
    calls_lock = threading.Lock()

    def runner(argv, *, input=None):
        nonlocal calls
        with calls_lock:
            calls += 1
        started.set()
        assert release.wait(timeout=5)
        return 0, ok_response()

    def invoke():
        jinn._on_pre_llm_call(
            session_id="s1",
            task_id="t1",
            user_message=MSG,
            is_first_turn=True,
        )

    first = threading.Thread(target=invoke)
    second = threading.Thread(target=lambda: (invoke(), second_finished.set()))
    jinn._runner = runner
    try:
        first.start()
        assert started.wait(timeout=2)
        second.start()
        returned_while_pickup_running = second_finished.wait(timeout=1)
        release.set()
        first.join(timeout=2)
        second.join(timeout=2)
    finally:
        release.set()
        jinn._runner = None

    assert returned_while_pickup_running is True
    assert calls == 1


def test_state_snapshot_is_created_without_holding_session_state_lock(
    tmp_path, monkeypatch
):
    snapshot = jinn.session_bridge.RepositorySnapshot(
        session_id="snapshot-lock-session",
        root=tmp_path,
        origin="https://github.com/acme/lock-check.git",
        repository_slug="acme/lock-check",
        base_head="0123456789abcdef",
    )
    lock_was_available = []

    def snapshot_repository(session_id, cwd=None):
        acquired = jinn._session_state_lock.acquire(blocking=False)
        lock_was_available.append(acquired)
        if acquired:
            jinn._session_state_lock.release()
        return snapshot

    monkeypatch.setattr(
        jinn.session_bridge,
        "snapshot_repository",
        snapshot_repository,
    )

    state = jinn._state_for("snapshot-lock-session", cwd=tmp_path)

    assert lock_was_available == [True]
    assert state["snapshot"] is snapshot


def test_state_snapshot_cannot_reinstall_state_after_turn_end(
    tmp_path, monkeypatch
):
    snapshot_started = threading.Event()
    release_snapshot = threading.Event()
    returned_states = []
    snapshot = jinn.session_bridge.RepositorySnapshot(
        session_id="snapshot-pop-session",
        root=tmp_path,
        origin="https://github.com/acme/pop-check.git",
        repository_slug="acme/pop-check",
        base_head="0123456789abcdef",
    )

    def snapshot_repository(session_id, cwd=None):
        snapshot_started.set()
        assert release_snapshot.wait(timeout=2)
        return snapshot

    monkeypatch.setattr(
        jinn.session_bridge,
        "snapshot_repository",
        snapshot_repository,
    )
    worker = threading.Thread(
        target=lambda: returned_states.append(
            jinn._state_for("snapshot-pop-session", cwd=tmp_path)
        )
    )
    worker.start()
    assert snapshot_started.wait(timeout=2)

    jinn._pop_state("snapshot-pop-session")
    release_snapshot.set()
    worker.join(timeout=2)

    assert not worker.is_alive()
    assert returned_states[0]["snapshot"] is snapshot
    assert "snapshot-pop-session" not in jinn._session_states


def test_finalize_during_pickup_cannot_resurrect_checkpoint():
    pickup_started = threading.Event()
    release_pickup = threading.Event()

    class BlockingPickupRunner(PickupRunner):
        def __call__(self, argv, *, input=None):
            self.calls.append((argv, input))
            if argv[1:3] == ["session", "pickup"]:
                pickup_started.set()
                assert release_pickup.wait(timeout=2)
            return self.code, self.out

    runner = BlockingPickupRunner()
    jinn._runner = runner
    worker = threading.Thread(
        target=lambda: jinn._on_pre_llm_call(
            session_id="finalize-during-pickup",
            task_id="stable-task",
            user_message=MSG,
            is_first_turn=True,
        )
    )
    try:
        worker.start()
        assert pickup_started.wait(timeout=2)
        jinn._on_session_finalize(
            session_id="finalize-during-pickup",
            reason="shutdown",
        )
        release_pickup.set()
        worker.join(timeout=2)
    finally:
        release_pickup.set()
        worker.join(timeout=2)
        jinn._runner = None

    assert not worker.is_alive()
    assert "finalize-during-pickup" not in jinn._pickup_checkpoints
    assert "finalize-during-pickup" not in jinn._session_states


def test_stale_pre_hook_cannot_reopen_finalized_session(
    monkeypatch,
):
    session_id = "finalize-before-state"
    task_id = "stale-task"
    capture_started = threading.Event()
    release_capture = threading.Event()
    worker_errors = []
    original_record_first_turn = jinn.buf.record_first_turn

    def blocking_record_first_turn(*args, **kwargs):
        capture_started.set()
        assert release_capture.wait(timeout=2)
        return original_record_first_turn(*args, **kwargs)

    def run_stale_pre_hook():
        try:
            jinn._on_pre_llm_call(
                session_id=session_id,
                task_id=task_id,
                user_message=MSG,
                is_first_turn=True,
            )
        except BaseException as exc:
            worker_errors.append(exc)

    monkeypatch.setattr(
        jinn.buf,
        "record_first_turn",
        blocking_record_first_turn,
    )
    runner = PickupRunner()
    jinn._runner = runner
    worker = threading.Thread(target=run_stale_pre_hook)
    try:
        worker.start()
        assert capture_started.wait(timeout=2)
        jinn._on_session_finalize(
            session_id=session_id,
            reason="shutdown",
        )
        release_capture.set()
        worker.join(timeout=2)
    finally:
        release_capture.set()
        worker.join(timeout=2)
        jinn._runner = None

    assert not worker.is_alive()
    assert worker_errors == []
    assert session_id not in jinn._session_states
    assert session_id not in jinn._pickup_checkpoints
    assert not jinn.buf.has_capture(task_id, session_id)
    assert [
        call
        for call in runner.calls
        if call[0][1:3] == ["session", "pickup"]
    ] == []


def test_parent_finalize_invalidates_blocked_internal_pre_hook(
    monkeypatch,
):
    parent_session_id = "blocked-internal-parent"
    capture_started = threading.Event()
    release_capture = threading.Event()
    worker_errors = []
    original_record_first_turn = jinn.buf.record_first_turn

    monkeypatch.setattr(
        jinn,
        "is_background_review",
        lambda: True,
    )

    def blocking_record_first_turn(*args, **kwargs):
        capture_started.set()
        assert release_capture.wait(timeout=2)
        return original_record_first_turn(*args, **kwargs)

    monkeypatch.setattr(
        jinn.buf,
        "record_first_turn",
        blocking_record_first_turn,
    )

    def run_internal_pre_hook():
        try:
            jinn._on_pre_llm_call(
                session_id=parent_session_id,
                task_id="internal-task",
                user_message=MSG,
                is_first_turn=True,
            )
        except BaseException as exc:
            worker_errors.append(exc)

    runner = PickupRunner()
    jinn._runner = runner
    worker = threading.Thread(target=run_internal_pre_hook)
    try:
        worker.start()
        assert capture_started.wait(timeout=2)
        logical_session_ids = [
            logical
            for (parent, _thread_id), logical
            in jinn._internal_sessions.items()
            if parent == parent_session_id
        ]
        assert len(logical_session_ids) == 1
        jinn._on_session_finalize(
            session_id=parent_session_id,
            reason="shutdown",
        )
        release_capture.set()
        worker.join(timeout=2)
    finally:
        release_capture.set()
        worker.join(timeout=2)
        jinn._runner = None

    logical_session_id = logical_session_ids[0]
    assert not worker.is_alive()
    assert worker_errors == []
    assert logical_session_id not in jinn._session_states
    assert logical_session_id not in jinn._pickup_checkpoints
    assert logical_session_id not in jinn._session_lifecycle_tokens
    assert jinn._internal_sessions == {}
    assert [
        call
        for call in runner.calls
        if call[0][1:3] == ["session", "pickup"]
    ] == []


def test_stale_old_capture_cannot_delete_fresh_same_id_lifecycle(
    monkeypatch,
):
    session_id = "same-id-reopen"
    old_capture_started = threading.Event()
    release_old_capture = threading.Event()
    old_worker_errors = []
    original_record_first_turn = jinn.buf.record_first_turn

    def blocking_old_record_first_turn(*args, **kwargs):
        if threading.current_thread().name == "old-pre-hook":
            old_capture_started.set()
            assert release_old_capture.wait(timeout=2)
        return original_record_first_turn(*args, **kwargs)

    monkeypatch.setattr(
        jinn.buf,
        "record_first_turn",
        blocking_old_record_first_turn,
    )

    def run_old_pre_hook():
        try:
            jinn._on_pre_llm_call(
                session_id=session_id,
                task_id="old-task",
                user_message="stale old user turn",
                is_first_turn=True,
            )
        except BaseException as exc:
            old_worker_errors.append(exc)

    runner = PickupRunner()
    jinn._runner = runner
    old_worker = threading.Thread(
        name="old-pre-hook",
        target=run_old_pre_hook,
    )
    try:
        old_worker.start()
        assert old_capture_started.wait(timeout=2)
        jinn._on_session_finalize(
            session_id=session_id,
            reason="old_session_complete",
        )
        fresh_result = jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="fresh-task",
            user_message="fresh new user turn",
            is_first_turn=True,
        )
        release_old_capture.set()
        old_worker.join(timeout=2)
    finally:
        release_old_capture.set()
        old_worker.join(timeout=2)
        jinn._runner = None

    matching_buffers = [
        buffer
        for key, buffer in jinn.buf._buffers.items()
        if key == session_id
        or (
            isinstance(key, tuple)
            and key[0] == session_id
        )
    ]
    assert not old_worker.is_alive()
    assert old_worker_errors == []
    assert fresh_result == {"context": CONTEXT_BLOCK}
    assert len(matching_buffers) == 1
    turn_texts = [
        turn["attributes"]["turn.text"]
        for turn in matching_buffers[0]["turns"]
    ]
    assert turn_texts == ["fresh new user turn"]
    assert len(runner.calls) == 1


def test_delayed_post_tool_after_finalize_cannot_recreate_ownership():
    session_id = "delayed-post-tool"
    task_id = "old-task"
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id=task_id,
            turn_id="old-turn",
            user_message="old user turn",
            is_first_turn=True,
        )
        jinn._on_session_finalize(
            session_id=session_id,
            reason="old_session_complete",
        )

        jinn._on_post_tool_call(
            session_id=session_id,
            task_id=task_id,
            turn_id="old-turn",
            tool_name="terminal",
            tool_call_id="old-tool",
            args={"command": "old command"},
            result={"exit_code": 0},
        )
    finally:
        jinn._runner = None

    assert session_id not in jinn._session_lifecycle_tokens
    assert session_id not in jinn._session_states
    assert session_id not in jinn._pickup_checkpoints
    assert getattr(jinn, "_session_turn_lifecycle_owners", {}) == {}
    assert not any(
        (key[0] if isinstance(key, tuple) else key) == session_id
        for key in jinn.buf._buffers
    )


def test_delayed_post_llm_after_finalize_cannot_recreate_capture():
    session_id = "delayed-post-llm"
    task_id = "old-task"
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id=task_id,
            turn_id="old-turn",
            user_message="old user turn",
            is_first_turn=True,
        )
        jinn._on_session_finalize(
            session_id=session_id,
            reason="old_session_complete",
        )

        jinn._on_post_llm_call(
            session_id=session_id,
            task_id=task_id,
            turn_id="old-turn",
            assistant_response="stale old response",
        )
    finally:
        jinn._runner = None

    assert session_id not in jinn._session_lifecycle_tokens
    assert getattr(jinn, "_session_turn_lifecycle_owners", {}) == {}
    assert not any(
        (key[0] if isinstance(key, tuple) else key) == session_id
        for key in jinn.buf._buffers
    )


def test_old_post_callbacks_cannot_contaminate_fresh_same_id_turn():
    session_id = "post-callback-same-id-reopen"
    runner = PickupRunner()
    jinn._runner = runner
    try:
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="old-task",
            turn_id="old-turn",
            user_message="old user turn",
            is_first_turn=True,
        )
        jinn._on_session_finalize(
            session_id=session_id,
            reason="old_session_complete",
        )
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="fresh-task",
            turn_id="fresh-turn",
            user_message="fresh user turn",
            is_first_turn=True,
        )

        jinn._on_post_tool_call(
            session_id=session_id,
            task_id="old-task",
            turn_id="old-turn",
            tool_name="terminal",
            tool_call_id="old-tool",
            args={"command": "old command"},
            result={"exit_code": 0},
        )
        jinn._on_post_llm_call(
            session_id=session_id,
            task_id="old-task",
            turn_id="old-turn",
            assistant_response="stale old response",
        )
        jinn._on_post_tool_call(
            session_id=session_id,
            task_id="fresh-task",
            turn_id="fresh-turn",
            tool_name="read_file",
            tool_call_id="fresh-tool",
            args={"path": "fresh.txt"},
            result="fresh contents",
        )
        jinn._on_post_llm_call(
            session_id=session_id,
            task_id="fresh-task",
            turn_id="fresh-turn",
            assistant_response="fresh response",
        )

        matching_buffers = [
            buffer
            for key, buffer in jinn.buf._buffers.items()
            if (
                key[0] if isinstance(key, tuple) else key
            ) == session_id
        ]
        assert len(matching_buffers) == 1
        buffer = matching_buffers[0]
        assert [
            step["name"]
            for step in buffer["steps"]
        ] == ["tool:read_file"]
        assert [
            turn["attributes"]["turn.text"]
            for turn in buffer["turns"]
        ] == ["fresh user turn", "fresh response"]
    finally:
        jinn._runner = None
        jinn._on_session_finalize(
            session_id=session_id,
            reason="test_cleanup",
        )


def test_post_hooks_without_turn_id_require_an_active_lifecycle():
    session_id = "legacy-post-active-only"

    jinn._on_post_tool_call(
        session_id=session_id,
        task_id="orphan-task",
        tool_name="terminal",
        tool_call_id="orphan-tool",
        args={"command": "orphan"},
        result={"exit_code": 0},
    )
    assert session_id not in jinn._session_lifecycle_tokens
    assert not any(
        (key[0] if isinstance(key, tuple) else key) == session_id
        for key in jinn.buf._buffers
    )

    jinn._runner = PickupRunner()
    try:
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="active-task",
            user_message="active user turn",
            is_first_turn=True,
        )
        jinn._on_post_tool_call(
            session_id=session_id,
            task_id="active-task",
            tool_name="terminal",
            tool_call_id="active-tool",
            args={"command": "active"},
            result={"exit_code": 0},
        )
        assert jinn.buf.has_steps(
            "active-task",
            session_id,
            lifecycle_token=jinn._current_session_lifecycle_token(
                session_id
            ),
        )
        jinn._on_session_finalize(
            session_id=session_id,
            reason="session_complete",
        )
        jinn._on_post_llm_call(
            session_id=session_id,
            task_id="active-task",
            assistant_response="late legacy response",
        )
    finally:
        jinn._runner = None

    assert session_id not in jinn._session_lifecycle_tokens
    assert not any(
        (key[0] if isinstance(key, tuple) else key) == session_id
        for key in jinn.buf._buffers
    )


def test_turn_lifecycle_ownership_is_bounded_after_turn_and_finalize():
    session_id = "bounded-turn-ownership"
    runner = PickupRunner()
    jinn._runner = runner
    try:
        for index in range(10):
            turn_id = f"turn-{index}"
            task_id = f"task-{index}"
            jinn._on_pre_llm_call(
                session_id=session_id,
                task_id=task_id,
                turn_id=turn_id,
                user_message=f"user turn {index}",
                is_first_turn=index == 0,
            )
            jinn._on_post_llm_call(
                session_id=session_id,
                task_id=task_id,
                turn_id=turn_id,
                assistant_response=f"response {index}",
            )
            jinn._on_session_end(
                session_id=session_id,
                task_id=task_id,
                turn_id=turn_id,
                completed=True,
                interrupted=False,
            )
            assert getattr(
                jinn,
                "_session_turn_lifecycle_owners",
                {},
            ) == {}
        jinn._on_session_finalize(
            session_id=session_id,
            reason="session_complete",
        )
    finally:
        jinn._runner = None

    lifecycle_maps = (
        "_session_states",
        "_session_state_tokens",
        "_pickup_checkpoints",
        "_session_lifecycle_tokens",
        "_session_turn_lifecycle_owners",
    )
    assert sum(
        len(getattr(jinn, name, {}))
        for name in lifecycle_maps
    ) == 0
    assert not any(
        (key[0] if isinstance(key, tuple) else key) == session_id
        for key in jinn.buf._buffers
    )


def test_finalize_closes_control_state_atomically_before_capture_cleanup(
    monkeypatch,
):
    session_id = "finalize-control-atomically"
    capture_started = threading.Event()
    release_capture = threading.Event()
    capture_cleanup_started = threading.Event()
    release_capture_cleanup = threading.Event()
    original_record_first_turn = jinn.buf.record_first_turn
    original_discard_session = jinn.buf.discard_session
    worker_errors = []

    def blocking_record_first_turn(*args, **kwargs):
        capture_started.set()
        assert release_capture.wait(timeout=2)
        return original_record_first_turn(*args, **kwargs)

    def blocking_finalize_discard(
        discarded_session_id,
        **kwargs,
    ):
        if threading.current_thread().name == "finalizer":
            capture_cleanup_started.set()
            assert release_capture_cleanup.wait(timeout=2)
        original_discard_session(
            discarded_session_id,
            **kwargs,
        )

    def run_pre_hook():
        try:
            jinn._on_pre_llm_call(
                session_id=session_id,
                task_id="stale-task",
                user_message=MSG,
                is_first_turn=True,
            )
        except BaseException as exc:
            worker_errors.append(exc)

    monkeypatch.setattr(
        jinn.buf,
        "record_first_turn",
        blocking_record_first_turn,
    )
    monkeypatch.setattr(
        jinn.buf,
        "discard_session",
        blocking_finalize_discard,
    )
    runner = PickupRunner()
    jinn._runner = runner
    pre_worker = threading.Thread(target=run_pre_hook)
    finalizer = threading.Thread(
        name="finalizer",
        target=lambda: jinn._on_session_finalize(
            session_id=session_id,
            reason="shutdown",
        ),
    )
    try:
        pre_worker.start()
        assert capture_started.wait(timeout=2)
        finalizer.start()
        assert capture_cleanup_started.wait(timeout=2)
        release_capture.set()
        pre_worker.join(timeout=2)
        release_capture_cleanup.set()
        finalizer.join(timeout=2)
    finally:
        release_capture.set()
        release_capture_cleanup.set()
        pre_worker.join(timeout=2)
        finalizer.join(timeout=2)
        jinn._runner = None

    assert not pre_worker.is_alive()
    assert not finalizer.is_alive()
    assert worker_errors == []
    assert session_id not in jinn._session_states
    assert session_id not in jinn._pickup_checkpoints
    assert [
        call
        for call in runner.calls
        if call[0][1:3] == ["session", "pickup"]
    ] == []


def test_old_finalize_capture_cleanup_preserves_fresh_same_id_lifecycle(
    monkeypatch,
):
    session_id = "finalize-capture-same-id-reopen"
    cleanup_started = threading.Event()
    release_cleanup = threading.Event()
    finalizer_errors = []
    background_review = [False]
    original_discard_session = jinn.buf.discard_session

    monkeypatch.setattr(
        jinn,
        "is_background_review",
        lambda: background_review[0],
    )

    def blocking_discard_session(
        discarded_session_id,
        **kwargs,
    ):
        if (
            threading.current_thread().name == "old-finalizer"
            and not cleanup_started.is_set()
        ):
            cleanup_started.set()
            assert release_cleanup.wait(timeout=2)
        original_discard_session(
            discarded_session_id,
            **kwargs,
        )

    monkeypatch.setattr(
        jinn.buf,
        "discard_session",
        blocking_discard_session,
    )

    runner = PickupRunner()
    jinn._runner = runner
    finalizer = None
    try:
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="old-parent-task",
            turn_id="old-parent-turn",
            user_message="old parent capture",
            is_first_turn=True,
        )
        old_parent_token = (
            jinn._current_session_lifecycle_token(session_id)
        )

        background_review[0] = True
        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="old-internal-task",
            turn_id="old-internal-turn",
            user_message="old internal capture",
            is_first_turn=True,
        )
        old_internal_session_id = next(
            logical
            for (parent, _thread_id), logical
            in jinn._internal_sessions.items()
            if parent == session_id
        )
        old_internal_token = (
            jinn._current_session_lifecycle_token(
                old_internal_session_id
            )
        )
        background_review[0] = False

        def finalize_old_lifecycle():
            try:
                jinn._on_session_finalize(
                    session_id=session_id,
                    reason="old_session_complete",
                )
            except BaseException as exc:
                finalizer_errors.append(exc)

        finalizer = threading.Thread(
            name="old-finalizer",
            target=finalize_old_lifecycle,
        )
        finalizer.start()
        assert cleanup_started.wait(timeout=2)
        assert session_id not in jinn._session_lifecycle_tokens
        assert (
            old_internal_session_id
            not in jinn._session_lifecycle_tokens
        )

        jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="fresh-parent-task",
            turn_id="fresh-parent-turn",
            user_message="fresh parent capture",
            is_first_turn=True,
        )
        fresh_parent_token = (
            jinn._current_session_lifecycle_token(session_id)
        )
        assert fresh_parent_token is not old_parent_token

        release_cleanup.set()
        finalizer.join(timeout=2)

        assert not finalizer.is_alive()
        assert finalizer_errors == []
        assert (
            jinn._current_session_lifecycle_token(session_id)
            is fresh_parent_token
        )
        assert (
            session_id,
            old_parent_token,
        ) not in jinn.buf._buffers
        assert (
            old_internal_session_id,
            old_internal_token,
        ) not in jinn.buf._buffers
        fresh_buffer = jinn.buf._buffers[
            (session_id, fresh_parent_token)
        ]
        assert [
            turn["attributes"]["turn.text"]
            for turn in fresh_buffer["turns"]
        ] == ["fresh parent capture"]
    finally:
        background_review[0] = False
        release_cleanup.set()
        if finalizer is not None:
            finalizer.join(timeout=2)
        jinn._on_session_finalize(
            session_id=session_id,
            reason="test_cleanup",
        )
        jinn._runner = None


def test_lifecycle_tracking_is_bounded_after_unique_session_cleanup():
    jinn._runner = PickupRunner()
    try:
        for index in range(100):
            session_id = f"internal-cleanup-{index}"
            jinn._on_pre_llm_call(
                session_id=session_id,
                task_id=f"task-{index}",
                user_message=MSG,
                is_first_turn=True,
            )
            jinn._on_session_finalize(
                session_id=session_id,
                reason="host_internal_complete",
            )
    finally:
        jinn._runner = None

    lifecycle_maps = (
        "_session_state_versions",
        "_pickup_checkpoint_versions",
        "_session_lifecycle_tokens",
        "_session_state_tokens",
    )
    assert sum(
        len(getattr(jinn, name, {}))
        for name in lifecycle_maps
    ) == 0
    assert not any(
        (
            key[0] if isinstance(key, tuple) else key
        ).startswith("internal-cleanup-")
        for key in jinn.buf._buffers
    )


def test_host_internal_terminal_cleanup_cannot_leave_reopened_lifecycle(
    monkeypatch,
):
    parent_session_id = "host-internal-parent"
    end_cleanup_started = threading.Event()
    release_end_cleanup = threading.Event()
    logical_session_ids = []
    worker_errors = []

    monkeypatch.setattr(
        jinn,
        "is_background_review",
        lambda: True,
    )

    def blocking_payoff_lines(snapshot):
        end_cleanup_started.set()
        assert release_end_cleanup.wait(timeout=2)
        return []

    monkeypatch.setattr(
        jinn.distill,
        "payoff_lines",
        blocking_payoff_lines,
    )

    def run_internal_session():
        try:
            jinn._on_pre_llm_call(
                session_id=parent_session_id,
                task_id="internal-task",
                user_message=MSG,
                is_first_turn=True,
            )
            logical_session_ids.extend(
                logical
                for (parent, _thread_id), logical
                in jinn._internal_sessions.items()
                if parent == parent_session_id
            )
            jinn._on_session_end(
                session_id=parent_session_id,
                task_id="internal-task",
                completed=True,
                interrupted=False,
            )
        except BaseException as exc:
            worker_errors.append(exc)

    jinn._runner = PickupRunner()
    worker = threading.Thread(target=run_internal_session)
    try:
        worker.start()
        assert end_cleanup_started.wait(timeout=2)
        assert len(logical_session_ids) == 1
        jinn._state_for(logical_session_ids[0])
        release_end_cleanup.set()
        worker.join(timeout=2)
    finally:
        release_end_cleanup.set()
        worker.join(timeout=2)
        jinn._runner = None

    logical_session_id = logical_session_ids[0]
    assert not worker.is_alive()
    assert worker_errors == []
    assert logical_session_id not in jinn._session_states
    assert logical_session_id not in jinn._session_state_tokens
    assert logical_session_id not in jinn._pickup_checkpoints
    assert logical_session_id not in jinn._session_lifecycle_tokens
    assert not any(
        parent == parent_session_id
        for parent, _thread_id in jinn._internal_sessions
    )


def test_session_start_opens_fresh_lifecycle_after_finalize(
    monkeypatch,
):
    session_id = "reopened-lifecycle"
    monkeypatch.setattr(
        jinn,
        "_park_contribution_publication",
        lambda: None,
    )
    monkeypatch.setattr(
        jinn.doctor,
        "run_checks",
        lambda **kwargs: [],
    )
    monkeypatch.setattr(
        jinn.doctor,
        "degraded_reason",
        lambda checks: None,
    )
    monkeypatch.setattr(
        jinn.doctor,
        "_first_session_done",
        lambda: True,
    )
    monkeypatch.setattr(
        jinn.distill,
        "reattach_watcher",
        lambda **kwargs: None,
    )
    monkeypatch.setattr(
        jinn.distill,
        "snapshot_usage",
        lambda: {},
    )

    jinn._on_session_finalize(
        session_id=session_id,
        reason="prior_session_complete",
    )
    jinn._on_session_start(
        session_id=session_id,
        platform="cli",
    )

    runner = PickupRunner()
    jinn._runner = runner
    try:
        result = jinn._on_pre_llm_call(
            session_id=session_id,
            task_id="new-task",
            user_message=MSG,
            is_first_turn=True,
        )
    finally:
        jinn._runner = None
        jinn._on_session_finalize(
            session_id=session_id,
            reason="test_cleanup",
        )

    assert result == {"context": CONTEXT_BLOCK}
    assert len(runner.calls) == 1


# ── Agent tools (unaffected by the pickup delegation) ───────────────────────

def test_corpus_search_tool_formats_hits_and_records_surfaced_refs(tmp_path):
    ref = "bafyPickupSkill"

    def runner(argv):
        if argv[1] == "corpus" and argv[2] == "search":
            return 0, json.dumps([{"ref": ref, "tags": ["tdd"], "summary": "Seed import: acme/skills/tdd"}])
        return 1, f"unexpected: {argv}"

    jinn._runner = runner
    try:
        out = jinn._tool_corpus_search({"query": "tdd"}, session_id="s1")
    finally:
        jinn._runner = None
    assert f"ref={ref}" in out
    assert "tags=[tdd]" in out
    assert jinn._state_for("s1")["activity"]["surfacedRefs"] == [ref]


def test_corpus_fetch_tool_returns_skill_content_and_records_fetched_ref(tmp_path):
    import base64
    import hashlib

    ref = "bafyPickupSkill"
    trace = {
        "schemaVersion": "jinn.trace-envelope.v0",
        "task": {"summary": "Seed import: acme/skills/tdd", "distributionTags": ["seed-import", "tdd"]},
        "steps": [{"spanId": "s1", "name": "seed:skill-md", "attributes": {
            "skill.md": "# tdd\n\nRed, green, refactor.",
            "seed.attribution": {"skill": "acme/skills/tdd"},
        }}],
        "outcome": {"status": "completed", "verifiabilityTier": "user-accepted"},
        "provenance": "imported",
    }
    content = json.dumps(trace).encode("utf-8")
    record = {
        "ref": ref,
        "artifacts": [{
            "artifactType": "jinn.trace-envelope.v0",
            "sha256": hashlib.sha256(content).hexdigest(),
            "contentBase64": base64.b64encode(content).decode("ascii"),
        }],
    }

    def runner(argv):
        if argv[1] == "corpus" and argv[2] == "get":
            return 0, json.dumps(record)
        return 1, f"unexpected: {argv}"

    jinn._runner = runner
    try:
        out = jinn._tool_corpus_fetch({"ref": ref}, session_id="s1")
    finally:
        jinn._runner = None
    assert "[user-accepted]" in out
    assert "Red, green, refactor." in out
    assert jinn._state_for("s1")["activity"]["fetchedRefs"] == [ref]


def test_corpus_fetch_tool_reads_canonical_episode_content(tmp_path):
    import base64
    import hashlib

    ref = "bafyCanonicalEpisode"
    episode = {
        "schemaVersion": "jinn.episode.v1",
        "episodeId": "episode:canonical",
        "retrievalVisible": True,
        "session": {
            "sessionId": "session:canonical",
            "capturedAt": "2026-07-20T00:00:00.000Z",
            "kind": "user",
        },
        "origin": {"writer": "jinn-agent", "build": "0.18.0"},
        "task": {
            "summary": "Seed import: acme/skills/tdd",
            "distributionTags": ["seed-import", "tdd"],
        },
        "trajectory": [{
            "spanId": "s1",
            "parentSpanId": None,
            "kind": "jinn.tool_call",
            "name": "seed:skill-md",
            "startTimeUnixNano": "1000000000",
            "endTimeUnixNano": "1000000000",
            "attributes": {
                "skill.md": "# canonical tdd\n\nRed, green, project.",
                "seed.attribution": {"skill": "acme/skills/tdd"},
            },
            "redactedKeys": [],
        }],
        "environment": {
            "harness": {"name": "hermes-agent", "version": "0.1.0"},
            "model": "test-model",
            "tools": [],
            "skillsLoadout": [],
        },
        "outcome": {
            "status": "completed",
            "verificationStrength": "tests-passed",
        },
        "cost": {"durationMs": 0},
        "retention": {"policy": "contribution-eligible"},
        "provenance": "imported",
    }
    content = json.dumps(episode).encode("utf-8")
    record = {
        "ref": ref,
        "artifacts": [{
            "artifactType": "jinn.episode.v1",
            "sha256": hashlib.sha256(content).hexdigest(),
            "contentBase64": base64.b64encode(content).decode("ascii"),
        }],
    }

    def runner(argv):
        if argv[1] == "corpus" and argv[2] == "get":
            return 0, json.dumps(record)
        return 1, f"unexpected: {argv}"

    jinn._runner = runner
    try:
        out = jinn._tool_corpus_fetch({"ref": ref}, session_id="s1")
    finally:
        jinn._runner = None
    assert "[tests-passed]" in out
    assert "Red, green, project." in out
    assert jinn._state_for("s1")["activity"]["fetchedRefs"] == [ref]
