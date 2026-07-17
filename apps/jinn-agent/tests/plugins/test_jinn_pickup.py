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


def test_pickup_renders_the_context_block_verbatim():
    runner = PickupRunner()
    result = pickup.pickup(MSG, runner=runner)
    assert result == {"context": CONTEXT_BLOCK}


def test_pickup_returns_none_when_nothing_is_provided():
    runner = PickupRunner(out=ok_response(contextBlock=None, packets=[]))
    assert pickup.pickup(MSG, runner=runner) is None


def test_pickup_returns_none_when_context_block_is_blank():
    runner = PickupRunner(out=ok_response(contextBlock="   "))
    assert pickup.pickup(MSG, runner=runner) is None


# ── Activity recording (rescope §3.6) ───────────────────────────────────────

def test_pickup_records_searched_terms_and_provided_refs():
    runner = PickupRunner()
    activity = {"searchedTerms": [], "providedRefs": [], "surfacedRefs": [], "fetchedRefs": []}

    pickup.pickup(MSG, runner=runner, activity=activity)

    assert activity["searchedTerms"] == ["dashboard", "vitest", "update_available"]
    assert activity["providedRefs"] == ["bafySourceEpisode"]
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


def test_pickup_does_not_touch_activity_when_the_call_fails():
    runner = PickupRunner(code=1, out="boom")
    activity = {"searchedTerms": ["stale"], "providedRefs": ["stale-ref"]}

    pickup.pickup(MSG, runner=runner, activity=activity)

    assert activity == {"searchedTerms": ["stale"], "providedRefs": ["stale-ref"]}


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
    assert activity == {}


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
