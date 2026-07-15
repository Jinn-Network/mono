"""Payload-agnostic auto-pickup tests (mono #1345, tier-keyed design).

The policy under test: adoption is gated by VERIFICATION TIER, not by a
human keystroke — `evaluator-verified` payloads adopt automatically;
unverified ones are suggested to the agent as injected context; unknown
payload types are never adopted; and none of it is consent-gated
(consuming is always allowed).
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
consent = importlib.import_module("plugins.jinn.consent")
pickup = importlib.import_module("plugins.jinn.pickup")
skills_install = importlib.import_module("plugins.jinn.skills_install")

REF = "bafyPickupSkill"


def trace(tier: str = "user-accepted", payload: str = "skill", slug: str = "tdd") -> dict:
    step_attrs: dict = {"seed.attribution": {"skill": f"acme/skills/{slug}"}}
    if payload == "skill":
        step_attrs["skill.md"] = f"# {slug}\n\nRed, green, refactor."
    return {
        "schemaVersion": "jinn.trace-envelope.v0",
        "task": {"summary": f"Seed import: acme/skills/{slug}", "distributionTags": ["seed-import", slug]},
        "steps": [{"spanId": "s1", "name": "seed:skill-md", "attributes": step_attrs}],
        "outcome": {"status": "completed", "verifiabilityTier": tier},
        "provenance": "imported",
    }


def record_for(t: dict) -> dict:
    content = json.dumps(t).encode("utf-8")
    return {
        "ref": REF,
        "artifacts": [{
            "artifactType": "jinn.trace-envelope.v0",
            "sha256": hashlib.sha256(content).hexdigest(),
            "contentBase64": base64.b64encode(content).decode("ascii"),
        }],
    }


class CorpusRunner:
    """Serves corpus search + corpus get for one canned record."""

    def __init__(self, t: dict, search_hit: bool = True):
        self.record = record_for(t)
        self.search_hit = search_hit
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        if argv[1] == "corpus" and argv[2] == "search":
            hits = [{"ref": REF, "tags": ["tdd"], "summary": "Seed import: acme/skills/tdd"}] if self.search_hit else []
            return 0, json.dumps(hits)
        if argv[1] == "corpus" and argv[2] == "get":
            return 0, json.dumps(self.record)
        return 1, f"unexpected: {argv}"


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    jinn._reset_session_state()
    yield tmp_path
    jinn._reset_session_state()


MSG = "Help me with tdd-style refactoring of this suite"


def _fake_install(tmp_path, slug: str = "tdd"):
    """Stand in for skills_install.install(): the adopt DECISION is under
    test here, not the layer shell-out (that's covered in
    test_jinn_skills_install.py). Writes the SKILL.md + .jinn-ref marker so
    on-disk assertions and list_installed()-based dedup still hold."""
    def fake(ref, runner=None):
        target = tmp_path / "skills" / slug
        target.mkdir(parents=True, exist_ok=True)
        (target / "SKILL.md").write_text(f"# {slug}\n")
        (target / ".jinn-ref").write_text(json.dumps({"ref": ref}) + "\n")
        return str(target / "SKILL.md")
    return fake


def test_verified_candidate_is_suggested_not_adopted_by_default(tmp_path):
    # Ratified: remote skills are manual-approval by default. With no
    # pickup.json (autoAdopt defaults to False), even an evaluator-verified
    # candidate is only suggested — never installed without a keystroke.
    runner = CorpusRunner(trace(tier="evaluator-verified"))
    result = pickup.pickup(MSG, runner=runner)
    assert result is not None
    ctx = result["context"]
    assert "install: /jinn skills install" in ctx      # suggested
    assert "Adopted automatically" not in ctx          # NOT adopted
    assert not (tmp_path / "skills").exists()


def test_opt_in_auto_adopts(tmp_path, monkeypatch):
    monkeypatch.setattr(skills_install, "install", _fake_install(tmp_path))
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"autoAdopt": True}))
    runner = CorpusRunner(trace(tier="evaluator-verified"))
    result = pickup.pickup(MSG, runner=runner)
    assert result is not None
    assert "Adopted automatically (verified)" in result["context"]
    # The skill landed where Hermes's native loader reads it — no confirm step.
    assert (tmp_path / "skills" / "tdd" / "SKILL.md").exists()


def test_pickup_reports_only_safely_observed_activity(tmp_path):
    runner = CorpusRunner(trace(tier="evaluator-verified"))
    activity = {"surfacedRefs": [], "fetchedRefs": [], "installedSkillRefs": []}

    pickup.pickup(MSG, runner=runner, activity=activity)

    assert activity == {
        "surfacedRefs": [REF],
        "fetchedRefs": [REF],
        "installedSkillRefs": [],
    }


def test_auto_adopt_reports_the_installed_ref(tmp_path, monkeypatch):
    monkeypatch.setattr(skills_install, "install", _fake_install(tmp_path))
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"autoAdopt": True}))
    activity = {"surfacedRefs": [], "fetchedRefs": [], "installedSkillRefs": []}

    pickup.pickup(
        MSG,
        runner=CorpusRunner(trace(tier="evaluator-verified")),
        activity=activity,
    )

    assert activity["installedSkillRefs"] == [REF]


def test_unverified_payload_suggests_but_never_installs(tmp_path):
    runner = CorpusRunner(trace(tier="user-accepted"))
    result = pickup.pickup(MSG, runner=runner)
    assert result is not None
    assert "unverified" in result["context"]
    assert "/jinn skills install" in result["context"]
    assert not (tmp_path / "skills").exists()


def test_tests_passed_tier_respects_configured_threshold(tmp_path, monkeypatch):
    monkeypatch.setattr(skills_install, "install", _fake_install(tmp_path))
    # Default threshold is evaluator-verified: tests-passed only suggests…
    runner = CorpusRunner(trace(tier="tests-passed"))
    result = pickup.pickup(MSG, runner=runner)
    assert not (tmp_path / "skills").exists()
    assert result is not None
    # …but an operator who opts into auto-adopt and lowers the threshold
    # gets auto-adoption.
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"autoAdopt": True, "autoAdoptTier": "tests-passed"}))
    runner2 = CorpusRunner(trace(tier="tests-passed"))
    pickup.pickup(MSG, runner=runner2)
    assert (tmp_path / "skills" / "tdd" / "SKILL.md").exists()


def test_unknown_payload_type_is_never_adopted(tmp_path):
    runner = CorpusRunner(trace(tier="evaluator-verified", payload="opaque"))
    result = pickup.pickup(MSG, runner=runner)
    # Verified unknown payloads are surfaced (suggest-only default must not
    # swallow them into silence) but never adopted.
    assert result is not None
    ctx = result["context"]
    assert "unknown" in ctx
    assert REF in ctx
    assert "Adopted automatically" not in ctx
    assert not (tmp_path / "skills").exists()


def test_pickup_is_not_consent_gated(tmp_path, monkeypatch):
    monkeypatch.setattr(skills_install, "install", _fake_install(tmp_path))
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"autoAdopt": True}))
    consent.save_state(False)
    runner = CorpusRunner(trace(tier="evaluator-verified"))
    result = pickup.pickup(MSG, runner=runner)
    assert result is not None
    assert (tmp_path / "skills" / "tdd" / "SKILL.md").exists()


def test_disabled_config_is_a_no_op(tmp_path):
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"enabled": False}))
    runner = CorpusRunner(trace(tier="evaluator-verified"))
    assert pickup.pickup(MSG, runner=runner) is None
    assert runner.calls == []


def test_already_installed_skill_is_skipped(tmp_path, monkeypatch):
    monkeypatch.setattr(skills_install, "install", _fake_install(tmp_path))
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"autoAdopt": True}))
    runner = CorpusRunner(trace(tier="evaluator-verified"))
    pickup.pickup(MSG, runner=runner)
    runner2 = CorpusRunner(trace(tier="evaluator-verified"))
    result = pickup.pickup(MSG, runner=runner2)
    assert result is None  # nothing new to say


def test_pickup_fails_open_on_broken_layer(tmp_path):
    def broken(argv):
        raise RuntimeError("boom")
    assert pickup.pickup(MSG, runner=broken) is None


def test_hook_returns_pickup_context_on_first_turn(tmp_path):
    runner = CorpusRunner(trace(tier="user-accepted"))
    jinn._runner = runner
    try:
        result = jinn._on_pre_llm_call(
            session_id="s1", task_id="t1", user_message=MSG, is_first_turn=True, model="m",
        )
    finally:
        jinn._runner = None
    assert result is not None and "context" in result
    assert jinn._on_pre_llm_call(session_id="s1", user_message=MSG, is_first_turn=False) is None


def test_derive_terms_skips_stopwords():
    assert pickup.derive_terms("Help me with tdd-style refactoring")[0] == "tdd-style"
    assert pickup.derive_terms("") == []


# ── Agent tools ──────────────────────────────────────────────────────────────

def test_corpus_search_tool_formats_hits_and_records_surfaced_refs(tmp_path):
    runner = CorpusRunner(trace())
    jinn._runner = runner
    try:
        out = jinn._tool_corpus_search({"query": "tdd"}, session_id="s1")
    finally:
        jinn._runner = None
    assert f"ref={REF}" in out
    assert "tags=[tdd]" in out
    assert jinn._state_for("s1")["activity"]["surfacedRefs"] == [REF]


def test_corpus_fetch_tool_returns_skill_content_and_records_fetched_ref(tmp_path):
    runner = CorpusRunner(trace(tier="user-accepted"))
    jinn._runner = runner
    try:
        out = jinn._tool_corpus_fetch({"ref": REF}, session_id="s1")
    finally:
        jinn._runner = None
    assert "[user-accepted]" in out
    assert "Red, green, refactor." in out
    assert jinn._state_for("s1")["activity"]["fetchedRefs"] == [REF]
