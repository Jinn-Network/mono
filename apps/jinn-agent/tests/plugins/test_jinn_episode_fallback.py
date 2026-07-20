"""Python owns exactly-once EpisodeV1 fallback persistence."""

from __future__ import annotations

import hashlib
import json
import stat

from plugins.jinn import distill


def _episode() -> dict:
    return {
        "schemaVersion": "jinn.episode.v1",
        "episodeId": "episode/id:1",
        "session": {"sessionId": "session-1", "capturedAt": "2026-07-15T00:00:00Z"},
        "task": {"summary": "fix it", "distributionTags": []},
        "trajectory": [
            {
                "spanId": "turn-1",
                "parentSpanId": None,
                "kind": "jinn.agent_turn",
                "name": "turn:user",
                "startTimeUnixNano": "1",
                "endTimeUnixNano": "1",
                "attributes": {"role": "user", "turn.text": "fix it"},
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
        "retention": {"policy": "local-private"},
        "provenance": "contributed",
    }


def test_fallback_preserves_the_complete_episode_and_writes_once(tmp_path, monkeypatch):
    episodes_dir = tmp_path / "episodes"
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(episodes_dir))
    episode = _episode()

    first = distill.write_episode_fallback(episode)
    original_bytes = first.read_bytes()
    second = distill.write_episode_fallback(episode)

    assert first == second
    assert len(list(episodes_dir.glob("*.json"))) == 1
    assert first.read_bytes() == original_bytes
    assert json.loads(original_bytes) == episode
    assert json.loads(original_bytes)["outcome"]["verificationStrength"] == "user-accepted"
    assert "verifiabilityTier" not in json.loads(original_bytes)["outcome"]
    digest = hashlib.sha256(episode["episodeId"].encode("utf-8")).hexdigest()
    assert first.name == f"episode-{digest}.episode.json"
    assert stat.S_IMODE(episodes_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(first.stat().st_mode) == 0o600
    assert list(episodes_dir.glob("*.tmp")) == []


def test_fallback_rejects_non_episode_data_without_writing(tmp_path, monkeypatch):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))

    assert distill.write_episode_fallback({"episodeId": "x"}) is None
    assert list(tmp_path.glob("*.json")) == []


def test_fallback_file_names_cannot_alias_after_sanitizing(tmp_path, monkeypatch):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    first = _episode()
    second = _episode()
    first["episodeId"] = "episode/id:1"
    second["episodeId"] = "episode:id/1"

    first_path = distill.write_episode_fallback(first)
    second_path = distill.write_episode_fallback(second)

    assert first_path != second_path
    assert len(list(tmp_path.glob("*.json"))) == 2


def test_fallback_rejects_same_id_with_different_content_without_overwrite(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    first = _episode()
    first["episodeId"] = "collision-id"
    second = json.loads(json.dumps(first))
    second["task"]["summary"] = "different content"

    first_path = distill.write_episode_fallback(first)
    original_bytes = first_path.read_bytes()
    first_path.chmod(0o644)
    collision = distill.write_episode_fallback(second)

    assert collision is None
    assert first_path.read_bytes() == original_bytes
    assert json.loads(original_bytes) == first
    assert stat.S_IMODE(first_path.stat().st_mode) == 0o600
    assert list(tmp_path.glob("*.tmp")) == []


def test_fallback_uses_the_core_filename_and_does_not_duplicate_a_lost_response(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    episode = _episode()
    episode["episodeId"] = "safe-episode-1"
    core_path = tmp_path / "safe-episode-1.episode.json"
    core_path.write_text(json.dumps(episode), encoding="utf-8")

    fallback_path = distill.write_episode_fallback(episode)

    assert fallback_path == core_path
    assert len(list(tmp_path.glob("*.episode.json"))) == 1
    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700
    assert stat.S_IMODE(core_path.stat().st_mode) == 0o600
