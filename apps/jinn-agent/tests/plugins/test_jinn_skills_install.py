"""skills_install module — shells to the layer (mono #1345, thin-fork boundary).

The acceptance criteria: install() no longer parses envelopes or verifies
hashes itself — it shells to `jinn-layer skills install <ref> --json`, which
does the extraction + sha256 verification + SKILL.md write, and only drops
the `.jinn-ref` marker into the dir the layer reports back; uninstall never
touches skills the user made themselves.

The module is retained as a quarantined Stage-3 surface (rescope plan §2):
the `/jinn skills install|list|uninstall` command branch that used to call
these functions is removed (Stage 1 rescope R3; skills are Stage 3), and
pickup's own auto-adopt path (which also called `install()`) is gone with
it. `skills_dir()`/`_extract_trace()`/`_skill_md_and_slug()` stay live,
consumed by `/jinn distill`'s staging dir and the `corpus_fetch` agent tool.
These tests cover the module's own functions directly, independent of any
command surface.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import importlib
import json
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
skills_install = importlib.import_module("plugins.jinn.skills_install")

REF = "bafySeedTdd"


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    jinn._reset_session_state()
    yield tmp_path
    jinn._reset_session_state()


def test_install_shells_to_layer_and_drops_marker(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    skills_root = tmp_path / "skills"

    def fake_runner(argv):
        # argv == ["jinn-layer", "skills", "install", "<ref>", "--json"]
        assert argv[1:4] == ["skills", "install", "abc123"]
        assert "--json" in argv
        target = skills_root / "flaky-retry"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("# skill\n")
        return 0, json.dumps({"dir": str(target), "name": "flaky-retry",
                              "shape": "package", "files": [], "provenance": {}})

    path = skills_install.install("abc123", runner=fake_runner)
    installed = Path(path)
    assert installed.name == "SKILL.md"
    assert (installed.parent / ".jinn-ref").exists()
    ref = json.loads((installed.parent / ".jinn-ref").read_text())["ref"]
    assert ref == "abc123"


def test_install_raises_on_layer_failure(tmp_path):
    def fake_runner(argv):
        return 1, "sha256 mismatch — refusing to install"

    with pytest.raises(ValueError, match="skills install failed"):
        skills_install.install(REF, runner=fake_runner)


def test_install_raises_on_unreadable_result(tmp_path):
    def fake_runner(argv):
        return 0, "not json"

    with pytest.raises(ValueError, match="unreadable skills install result"):
        skills_install.install(REF, runner=fake_runner)


def _artifact(artifact_type, payload, *, sha256=None):
    content = json.dumps(payload).encode("utf-8")
    return {
        "artifactType": artifact_type,
        "sha256": sha256 or hashlib.sha256(content).hexdigest(),
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }


def _valid_episode():
    return {
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
            "summary": "canonical",
            "distributionTags": ["canonical"],
        },
        "trajectory": [{
            "spanId": "canonical-step",
            "parentSpanId": None,
            "kind": "jinn.tool_call",
            "name": "seed:skill-md",
            "startTimeUnixNano": "1000000000",
            "endTimeUnixNano": "1000000000",
            "attributes": {"skill.md": "# canonical"},
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


def test_extract_trace_prefers_hash_verified_episode_and_projects_legacy_read_shape():
    legacy = {
        "schemaVersion": "jinn.trace-envelope.v0",
        "task": {"summary": "legacy", "distributionTags": ["legacy"]},
        "steps": [],
        "outcome": {"status": "completed", "verifiabilityTier": "user-accepted"},
    }
    episode = _valid_episode()

    projected, digest = skills_install._extract_trace({
        "artifacts": [
            _artifact("jinn.trace-envelope.v0", legacy),
            _artifact("jinn.episode.v1", episode),
        ],
    })

    assert projected["schemaVersion"] == "jinn.episode.v1"
    assert projected["steps"] == episode["trajectory"]
    assert projected["outcome"]["verifiabilityTier"] == "tests-passed"
    assert digest == hashlib.sha256(json.dumps(episode).encode("utf-8")).hexdigest()


def test_extract_trace_does_not_fall_back_when_preferred_episode_hash_mismatches():
    legacy = {
        "schemaVersion": "jinn.trace-envelope.v0",
        "task": {"summary": "legacy", "distributionTags": ["legacy"]},
        "steps": [],
        "outcome": {"status": "completed", "verifiabilityTier": "user-accepted"},
    }
    episode = _valid_episode()

    with pytest.raises(ValueError, match="sha256 mismatch"):
        skills_install._extract_trace({
            "artifacts": [
                _artifact("jinn.trace-envelope.v0", legacy),
                _artifact("jinn.episode.v1", episode, sha256="0" * 64),
            ],
        })


def test_extract_trace_accepts_episode_reader_defaults_and_legacy_outcome_axis():
    episode = copy.deepcopy(_valid_episode())
    episode["session"].pop("kind")
    episode.pop("origin")
    episode["task"].pop("distributionTags")
    episode["trajectory"][0].pop("redactedKeys")
    episode["outcome"]["verifiabilityTier"] = (
        episode["outcome"].pop("verificationStrength")
    )
    episode.pop("provenance")
    episode["futureTopLevelField"] = {"preserved": True}
    episode["trajectory"][0]["futureStepField"] = "preserved"

    projected, _digest = skills_install._extract_trace({
        "artifacts": [_artifact("jinn.episode.v1", episode)],
    })

    assert projected["outcome"]["verifiabilityTier"] == "tests-passed"
    assert projected["futureTopLevelField"] == {"preserved": True}
    assert projected["steps"][0]["futureStepField"] == "preserved"


@pytest.mark.parametrize(
    ("field_path", "mutate"),
    [
        ("environment", lambda episode: episode.pop("environment")),
        ("trajectory", lambda episode: episode.update({"trajectory": []})),
        (
            "trajectory[0].attributes",
            lambda episode: episode["trajectory"][0].update({"attributes": []}),
        ),
        (
            "trajectory[0].parentSpanId",
            lambda episode: episode["trajectory"][0].pop("parentSpanId"),
        ),
        (
            "outcome.verificationStrength",
            lambda episode: episode["outcome"].update(
                {"verificationStrength": "strong"}
            ),
        ),
    ],
)
def test_extract_trace_rejects_malformed_preferred_episode_without_legacy_fallback(
    field_path, mutate
):
    legacy = {
        "schemaVersion": "jinn.trace-envelope.v0",
        "task": {"summary": "legacy", "distributionTags": ["legacy"]},
        "steps": [],
        "outcome": {"status": "completed", "verifiabilityTier": "user-accepted"},
    }
    episode = copy.deepcopy(_valid_episode())
    mutate(episode)

    with pytest.raises(ValueError, match=field_path.replace("[", r"\[")):
        skills_install._extract_trace({
            "artifacts": [
                _artifact("jinn.trace-envelope.v0", legacy),
                _artifact("jinn.episode.v1", episode),
            ],
        })


def test_uninstall_refuses_unmarked(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    d = tmp_path / "skills" / "mine"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("# mine\n")  # no .jinn-ref marker
    try:
        skills_install.uninstall("mine")
        assert False, "should have refused"
    except ValueError as exc:
        assert "marker" in str(exc)


def test_list_and_uninstall_only_touch_jinn_installed(tmp_path):
    # A skill the user made themselves — no marker.
    user_skill = tmp_path / "skills" / "my-own-skill"
    user_skill.mkdir(parents=True)
    (user_skill / "SKILL.md").write_text("# mine\n")

    skills_root = tmp_path / "skills"

    def fake_runner(argv):
        target = skills_root / "test-driven-development"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("# TDD\n")
        return 0, json.dumps({"dir": str(target), "name": "test-driven-development",
                              "shape": "package", "files": [], "provenance": {}})

    skills_install.install(REF, runner=fake_runner)

    listed = skills_install.list_installed()
    assert [row["slug"] for row in listed] == ["test-driven-development"]

    with pytest.raises(ValueError, match="refusing"):
        skills_install.uninstall("my-own-skill")
    assert user_skill.exists()

    skills_install.uninstall("test-driven-development")
    assert not (tmp_path / "skills" / "test-driven-development").exists()
