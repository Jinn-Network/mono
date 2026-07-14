"""Mineable-trace consent — the two-tier D2 flow (task-creator spec §10).

`run_consent_flow` asks up to two questions after the contribution decision:
(1) retain scrubbed traces locally for mining, (2) allow a mined task to
later be published. Tier-2 is CONDITIONAL on tier-1 — with retention
declined there is nothing that could ever be published, so the publish
question is skipped entirely and publish consent is forced off. Both default
to decline on bare Enter — the safe default retains and publishes nothing.
See mono#1312 (consent) and spec/2026-07-08-task-creator-v0.md §10 (D2) for
the policy this implements.

Mirrors the conventions of apps/jinn-agent/tests/plugins/test_jinn_plugin.py's
consent-flow tests (isolated HERMES_HOME, `iter([...])` answer scripting).
"""

from __future__ import annotations

import importlib

import pytest

consent = importlib.import_module("plugins.jinn.consent")


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    yield


def _run(answers: list[str]) -> tuple[str, list[str]]:
    it = iter(answers)
    printed: list[str] = []
    status = consent.run_consent_flow(lambda _: next(it), printed.append)
    return status, printed


# ── Default (bare Enter) declines both tiers ─────────────────────────────────


def test_bare_enter_declines_both_mineable_tiers():
    # explainer -> decline confirm -> tier1 skip -> tier2 skip -> node stub skip
    status, printed = _run(["", "y", "", "", ""])
    assert status == consent.DECLINED
    state = consent.load_state()
    assert state["mineableTraceConsent"] == "off"
    assert state["publishMinedTasksConsent"] is False
    assert consent.mineable_trace_enabled() is False


def test_both_prompts_are_shown_when_tier1_is_accepted():
    # explainer -> decline confirm -> tier1 accept -> tier2 skip -> node stub skip
    _, printed = _run(["", "y", "y", "", ""])
    joined = "\n".join(printed)
    assert consent.MINEABLE_TRACE_HEADER in joined
    assert consent.MINEABLE_TRACE_BODY in joined
    assert consent.MINEABLE_PUBLISH_HEADER in joined
    assert consent.MINEABLE_PUBLISH_BODY in joined


# ── Tier-2 is conditional on tier-1 (D2 regression — coordinator review) ─────


def test_tier2_prompt_is_never_shown_when_tier1_is_declined():
    # explainer -> decline confirm -> tier1 skip -> (tier2 SKIPPED) -> node stub
    _, printed = _run(["", "y", "", "", ""])
    joined = "\n".join(printed)
    assert consent.MINEABLE_TRACE_HEADER in joined  # tier-1 was asked
    assert consent.MINEABLE_PUBLISH_HEADER not in joined  # tier-2 never asked
    assert consent.MINEABLE_PUBLISH_BODY not in joined


def test_tier1_declined_forces_publish_consent_off_regardless_of_input():
    # explainer -> decline confirm -> tier1 skip -> 'y' (would have accepted
    # tier-2, but tier-2 is skipped so it lands on the node stub) -> unused.
    # An eager 'y' must not leak into publish consent for data that was never
    # consented to be retained.
    status, printed = _run(["", "y", "", "y", ""])
    assert status == consent.DECLINED
    state = consent.load_state()
    assert state["mineableTraceConsent"] == "off"
    assert state["publishMinedTasksConsent"] is False
    assert consent.MINEABLE_PUBLISH_HEADER not in "\n".join(printed)


# ── Explicit accept on tier 1 only ────────────────────────────────────────────


def test_accepting_tier1_only_leaves_tier2_declined():
    # explainer -> decline confirm -> tier1 accept -> tier2 skip -> node stub skip
    status, _ = _run(["", "y", "y", "", ""])
    assert status == consent.DECLINED
    state = consent.load_state()
    assert state["mineableTraceConsent"] == "retain_local"
    assert state["publishMinedTasksConsent"] is False
    assert consent.mineable_trace_enabled() is True


# ── Explicit accept on both tiers ─────────────────────────────────────────────


def test_accepting_both_tiers_persists_both():
    # explainer -> accept -> confirm accept -> tier1 accept -> tier2 accept -> node stub skip
    status, _ = _run(["a", "y", "y", "y", ""])
    assert status == consent.ACCEPTED
    state = consent.load_state()
    assert state["mineableTraceConsent"] == "retain_local"
    assert state["publishMinedTasksConsent"] is True
    assert consent.mineable_trace_enabled() is True


# ── Mineable-trace consent is independent of the contribution decision ───────


def test_mineable_tiers_can_be_accepted_even_when_contribution_is_declined():
    # explainer -> decline confirm -> tier1 accept -> tier2 accept -> node stub skip
    status, _ = _run(["", "y", "y", "y", ""])
    assert status == consent.DECLINED
    assert consent.capture_enabled() is False  # contribution stays off
    assert consent.mineable_trace_enabled() is True  # tier-1 is independent
    assert consent.load_state()["publishMinedTasksConsent"] is True


# ── render_mineable_trace_prompt / render_mineable_publish_prompt copy ──────


def test_render_mineable_trace_prompt_copy():
    text = consent.render_mineable_trace_prompt()
    assert consent.MINEABLE_TRACE_HEADER in text
    assert "[Y] Yes" in text and "[N] No" in text


def test_render_mineable_publish_prompt_copy():
    text = consent.render_mineable_publish_prompt()
    assert consent.MINEABLE_PUBLISH_HEADER in text
    assert "[Y] Yes" in text and "[N] No" in text


# ── save_state round-trip for the mineable fields (regression guard) ────────


def test_save_state_persists_and_reloads_mineable_fields():
    consent.save_state(
        consent.ACCEPTED,
        mineable_trace_consent="retain_local",
        publish_mined_tasks_consent=True,
    )
    reloaded = consent.load_state()
    assert reloaded["mineableTraceConsent"] == "retain_local"
    assert reloaded["publishMinedTasksConsent"] is True
