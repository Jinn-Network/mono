"""Share consent — the single sharing question (mono#1714).

`run_consent_flow` asks exactly ONE contribution-consent question (about
sharing tasks derived from your work), defaulting to decline. There is no
longer a tier-1 (local retention) or tier-2 (publish mined tasks) prompt:
local capture, mining, and distillation happen unconditionally, and the one
recorded flag (`shareConsent`) governs only whether a mined task may leave
the machine.

Mirrors the conventions of apps/jinn-agent/tests/plugins/test_jinn_plugin.py's
consent-flow tests (isolated HERMES_HOME, `iter([...])` answer scripting).
"""

from __future__ import annotations

import importlib
import json

import pytest

consent = importlib.import_module("plugins.jinn.consent")


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    yield


def _run(answers: list[str]) -> tuple[bool, list[str]]:
    it = iter(answers)
    printed: list[str] = []
    share = consent.run_consent_flow(lambda _: next(it), printed.append)
    return share, printed


# ── Default (bare Enter) declines sharing ────────────────────────────────────


def test_bare_enter_declines_share():
    # explainer -> decline confirm -> node stub skip
    share, _ = _run(["", "y", ""])
    assert share is False
    assert consent.load_state()["shareConsent"] is False
    assert consent.share_enabled() is False


def test_accept_sets_share_true():
    # explainer -> accept -> confirm accept -> node stub skip
    share, _ = _run(["a", "y", ""])
    assert share is True
    assert consent.load_state()["shareConsent"] is True
    assert consent.share_enabled() is True


# ── AC4: exact copy, single question, no jargon ──────────────────────────────


def test_single_prompt_copy_matches_ac4():
    text = consent.render_explainer()
    assert "Contribute tasks from your work?" in text
    assert (
        "When you solve something on a public project, Jinn can turn it into a "
        "task other agents can attempt"
    ) in text
    assert "a reproducible problem based on your work" in text
    assert "Your actual code and history stay on your machine." in text
    assert "Jinn works fully either way." in text


def test_no_traces_or_mining_jargon():
    text = consent.render_explainer().lower()
    for jargon in ("trace", "mining", "mineable", "scrubbed", "corpus"):
        assert jargon not in text


# ── AC5: single flag, no tier / status state remains ─────────────────────────


def test_no_tier_state_remains():
    _run(["", "y", ""])
    state = consent.load_state()
    assert set(state.keys()) <= {"shareConsent", "previewed", "recordedAt"}
    assert "status" not in state
    assert "mineableTraceConsent" not in state
    assert "publishMinedTasksConsent" not in state


# ── Migration: only the old publish bit maps to share ────────────────────────


def test_legacy_publish_consent_maps_to_share():
    path = consent.state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"status": "accepted", "publishMinedTasksConsent": True}),
        encoding="utf-8",
    )
    assert consent.load_state()["shareConsent"] is True


def test_legacy_retention_only_declines_share():
    path = consent.state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "status": "accepted",
                "mineableTraceConsent": "retain_local",
                "publishMinedTasksConsent": False,
            }
        ),
        encoding="utf-8",
    )
    assert consent.load_state()["shareConsent"] is False


def test_save_state_round_trips_share():
    consent.save_state(True)
    reloaded = consent.load_state()
    assert reloaded["shareConsent"] is True
    consent.save_state(False)
    assert consent.load_state()["shareConsent"] is False
