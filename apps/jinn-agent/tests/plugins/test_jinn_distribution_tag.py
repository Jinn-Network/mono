"""Published traces must tag as ``jinn-agent``, not the upstream name.

Regression for the 2026-07-03 end-to-end run: live-published envelopes
carried ``task.distributionTags: ["jinn-hermes", ...]`` while the same
envelope's ``environment.harness.name`` said ``jinn-agent`` — the tag list
was hard-coded to the pre-rebrand name, leaking upstream branding into
permanent, anchored protocol data and splitting distribution-signal
grouping across two names for one harness.

Mono issue: Jinn-Network/mono#1362.
"""

from __future__ import annotations

import importlib

capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")


def _assembled(platform: str = ""):
    capture_buffer.reset()
    capture_buffer.record_first_turn("t1", "s1", "do a thing", "some-model", platform)
    capture_buffer.record_tool_call("t1", "s1", "terminal", "call1", {"command": "ls"}, "ok")
    task = capture_buffer.assemble("t1", "s1", completed=True, interrupted=False)
    capture_buffer.reset()
    assert task is not None
    return task


def test_distribution_tag_is_the_product_name(monkeypatch):
    # Fork behaviour: bin/jinn-agent exports JINN_HARNESS_NAME=jinn-agent.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    tags = _assembled()["task"]["distributionTags"]
    assert "jinn-agent" in tags
    assert all("hermes" not in t for t in tags), tags


def test_tag_stays_consistent_with_harness_metadata(monkeypatch):
    # Fork behaviour: bin/jinn-agent exports JINN_HARNESS_NAME=jinn-agent.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    task = _assembled(platform="cli")
    assert task["environment"]["harness"]["name"] == "jinn-agent"
    assert "jinn-agent" in task["task"]["distributionTags"]
    assert "cli" in task["task"]["distributionTags"]
