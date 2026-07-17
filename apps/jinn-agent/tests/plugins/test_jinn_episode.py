"""EpisodeV1 assembly — the complete-trajectory record (mono #1662).

The plugin buffers the full trajectory (user turn → tool calls → assistant
turn) and, at session end, emits an ``EpisodeV1`` alongside the legacy
``CapturedTask`` tee. These tests pin the emitted dict to the schema of record
(``packages/plugin/src/schemas/episode.ts``): strict keys, ordered
``kind``-discriminated trajectory, skills loadout, optional token cost, and a
retention policy that flips with publish consent.
"""

from __future__ import annotations

import importlib

capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")

_EPISODE_TOP_KEYS = {
    "schemaVersion",
    "episodeId",
    "session",
    "task",
    "trajectory",
    "environment",
    "outcome",
    "cost",
    "retention",
    "provenance",
}


def _drive(session="s", publish=False):
    capture_buffer.reset()
    capture_buffer.record_first_turn(session, session, "fix the retry bug", "gpt-4o-mini", "cli")
    capture_buffer.record_user_turn(session, session, "fix the retry bug")
    capture_buffer.record_tool_call(session, session, "edit", "c1", {"path": "x"}, "ok", 5)
    capture_buffer.record_assistant_turn(session, session, "fixed it")
    capture_buffer.record_environment(session, session, skills_loadout=["tdd", "debugging"])
    capture_buffer.record_tokens(session, session, input=100, output=50)
    return capture_buffer.assemble_episode(
        session, session, completed=True, interrupted=False, publish_consented=publish
    )


def test_assemble_episode_shape():
    ep = _drive()
    capture_buffer.reset()
    assert ep["schemaVersion"] == "jinn.episode.v1"
    assert ep["episodeId"]
    assert ep["session"]["sessionId"] == "s"
    # ISO-8601 with a Z suffix (mirrors capturedAt in assemble()).
    assert ep["session"]["capturedAt"].endswith("Z")

    traj = ep["trajectory"]
    assert [step["kind"] for step in traj] == [
        "jinn.agent_turn",
        "jinn.tool_call",
        "jinn.agent_turn",
    ]
    assert traj[0]["attributes"]["role"] == "user"
    assert traj[2]["attributes"]["role"] == "assistant"

    env = ep["environment"]
    assert env["skillsLoadout"] == ["tdd", "debugging"]
    assert env["tools"] == sorted(env["tools"])
    assert env["harness"]["name"]
    assert env["harness"]["version"]
    assert env["model"] == "gpt-4o-mini"

    assert isinstance(ep["cost"]["durationMs"], int) and ep["cost"]["durationMs"] >= 0
    assert ep["cost"]["tokens"] == {"input": 100, "output": 50}

    assert ep["outcome"]["status"] == "completed"
    assert ep["outcome"]["verifiabilityTier"] == "user-accepted"

    assert ep["retention"]["policy"] == "local-private"
    assert ep["provenance"] == "contributed"

    # Strict-object guard: no keys beyond the schema.
    assert set(ep.keys()) == _EPISODE_TOP_KEYS


def test_assemble_episode_returns_none_when_empty():
    capture_buffer.reset()
    ep = capture_buffer.assemble_episode("s", "s", completed=True, interrupted=False)
    capture_buffer.reset()
    assert ep is None


def test_retention_policy_flips_with_publish_consent():
    ep = _drive(publish=True)
    capture_buffer.reset()
    assert ep["retention"]["policy"] == "contribution-eligible"
