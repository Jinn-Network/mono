"""Python owns exactly-once EpisodeV1 fallback persistence."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat

from plugins.jinn import distill


def _episode() -> dict:
    return {
        "schemaVersion": "jinn.episode.v1",
        "episodeId": "episode/id:1",
        "retrievalVisible": False,
        "session": {
            "sessionId": "session-1",
            "capturedAt": "2026-07-15T00:00:00Z",
            "kind": "user",
        },
        "origin": {"writer": "jinn-agent", "build": "test"},
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
    with sqlite3.connect(episodes_dir / ".jinn-evidence-store-lock.sqlite") as lock:
        assert lock.execute("PRAGMA application_id").fetchone()[0] == 0x4A4C4F43
        assert lock.execute(
            "SELECT value FROM evidence_store_lock_meta WHERE key = 'schema_version'"
        ).fetchone()[0] == "1"


def test_fallback_refreshes_the_derived_index_after_releasing_the_store_lock(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    calls = []

    def run(args, **kwargs):
        lock_path = tmp_path / ".jinn-evidence-store-lock.sqlite"
        with sqlite3.connect(lock_path, timeout=0, isolation_level=None) as lock:
            lock.execute("BEGIN IMMEDIATE")
            lock.execute("ROLLBACK")
        calls.append((args, kwargs))
        return 0, "{}", ""

    monkeypatch.setattr(distill.jinn_layer, "run", run)

    result = distill.write_episode_fallback(_episode())

    assert result is not None
    assert calls == [(["reindex", "--json"], {"timeout_s": 30})]


def test_fallback_rejects_non_episode_data_without_writing(tmp_path, monkeypatch):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))

    assert distill.write_episode_fallback({"episodeId": "x"}) is None
    assert list(tmp_path.glob("*.json")) == []


def test_fallback_rejects_unknown_fields_at_every_strict_write_boundary(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    top_level = _episode()
    top_level["futureField"] = True
    nested = _episode()
    nested["task"]["futureField"] = True

    assert distill.write_episode_fallback(top_level) is None
    assert distill.write_episode_fallback(nested) is None
    assert list(tmp_path.glob("*.json")) == []


def test_fallback_rejects_reader_only_defaults_and_null_compatibility(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    missing_kind = _episode()
    missing_kind["session"].pop("kind")
    missing_origin = _episode()
    missing_origin.pop("origin")
    null_optional = _episode()
    null_optional["task"]["baseCommit"] = None

    assert distill.write_episode_fallback(missing_kind) is None
    assert distill.write_episode_fallback(missing_origin) is None
    assert distill.write_episode_fallback(null_optional) is None
    assert list(tmp_path.glob("*.json")) == []


def test_fallback_enforces_write_only_delivery_hash_invariant(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    episode = _episode()
    episode["activity"] = {
        "searchedTerms": ["dashboard"],
        "providedRefs": ["bafy-delivered"],
        "surfacedRefs": [],
        "fetchedRefs": [],
        "installedSkillRefs": [],
        "retrievalFired": True,
        "eligibleRefs": ["bafy-delivered"],
        "deliveredRefs": ["bafy-delivered"],
        "deliveryMode": "delivered",
    }

    assert distill.write_episode_fallback(episode) is None
    assert list(tmp_path.glob("*.json")) == []


def test_fallback_materializes_only_strict_writer_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    episode = _episode()
    episode.pop("retrievalVisible")
    episode.pop("provenance")
    episode["task"].pop("distributionTags")
    episode["trajectory"][0].pop("redactedKeys")
    episode["environment"]["verifier"] = {"type": "none"}
    episode["attemptGroup"] = {
        "groupId": "group",
        "attemptId": "attempt",
    }
    episode["outcome"]["verifiabilityTier"] = episode["outcome"].pop(
        "verificationStrength"
    )

    path = distill.write_episode_fallback(episode)
    stored = json.loads(path.read_text(encoding="utf-8"))

    assert stored["retrievalVisible"] is False
    assert stored["provenance"] == "contributed"
    assert stored["task"]["distributionTags"] == []
    assert stored["trajectory"][0]["redactedKeys"] == []
    assert stored["environment"]["verifier"] == {
        "type": "none",
        "failToPass": [],
        "passToPass": [],
    }
    assert stored["attemptGroup"]["relatedAttemptRefs"] == []
    assert stored["outcome"]["verificationStrength"] == "user-accepted"
    assert "verifiabilityTier" not in stored["outcome"]


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


def test_fallback_keeps_hashed_namespace_disjoint_and_within_name_max(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    unsafe = _episode()
    unsafe["episodeId"] = "../evil"
    old_collision = _episode()
    digest = hashlib.sha256(b"../evil").hexdigest()
    old_collision["episodeId"] = f"episode-{digest}"
    long_id = _episode()
    long_id["episodeId"] = "x" * 300

    paths = [
        distill.write_episode_fallback(unsafe),
        distill.write_episode_fallback(old_collision),
        distill.write_episode_fallback(long_id),
    ]

    assert len(set(paths)) == 3
    assert all(len(path.name.encode("utf-8")) <= 255 for path in paths)


def test_fallback_rejects_a_symlinked_evidence_directory(tmp_path, monkeypatch):
    real = tmp_path / "real"
    linked = tmp_path / "linked"
    real.mkdir()
    linked.symlink_to(real, target_is_directory=True)
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(linked))

    assert distill.write_episode_fallback(_episode()) is None
    assert list(real.glob("*.episode.json")) == []


def test_fallback_rejects_a_hardlinked_existing_episode_without_chmod(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    episode = _episode()
    episode["episodeId"] = "hardlinked"
    path = tmp_path / "hardlinked.episode.json"
    path.write_text(json.dumps(episode), encoding="utf-8")
    alias = tmp_path / "alias"
    os.link(path, alias)
    path.chmod(0o644)

    assert distill.write_episode_fallback(episode) is None
    assert stat.S_IMODE(path.stat().st_mode) == 0o644
    assert stat.S_IMODE(alias.stat().st_mode) == 0o644


def test_fallback_recovers_a_temp_alias_left_after_canonical_publication(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    episode = _episode()
    episode["episodeId"] = "recovered-write"
    path = tmp_path / "recovered-write.episode.json"
    orphan = tmp_path / ".recovered-write.abcdef12.tmp"
    orphan.write_text(json.dumps(episode), encoding="utf-8")
    os.link(orphan, path)

    result = distill.write_episode_fallback(episode)

    assert result == path
    assert not orphan.exists()
    assert path.stat().st_nlink == 1
    assert json.loads(path.read_text(encoding="utf-8")) == episode


def test_fallback_removes_a_temp_abandoned_before_canonical_publication(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("JINN_LAYER_EPISODES_DIR", str(tmp_path))
    orphan = tmp_path / ".abandoned.abcdef12.tmp"
    orphan.write_text('{"partial":true}', encoding="utf-8")

    result = distill.write_episode_fallback(_episode())

    assert result is not None
    assert not orphan.exists()


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
