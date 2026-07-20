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


def test_extract_trace_accepts_fully_populated_additive_episode_reader_shape():
    episode = copy.deepcopy(_valid_episode())
    episode.update({
        "futureTopLevelField": {"nested": ["preserved"]},
        "session": {
            **episode["session"],
            "parentSessionId": "session:parent",
            "futureSessionField": {"preserved": True},
        },
        "origin": {
            **episode["origin"],
            "futureOriginField": ["preserved"],
        },
        "task": {
            **episode["task"],
            "repositorySlug": "Jinn-Network/jinn-mono",
            "baseCommit": "a" * 40,
            "createdAt": 1_752_000_000,
            "instanceId": "django__django-12345",
            "futureTaskField": {"preserved": True},
        },
        "environment": {
            **episode["environment"],
            "harness": {
                **episode["environment"]["harness"],
                "futureHarnessField": "preserved",
            },
            "generatorModel": {
                "id": "test-model",
                "provider": "test-provider",
                "openWeights": False,
                "source": "stream",
                "futureGeneratorField": {"preserved": True},
            },
            "distributionClass": "restricted-tos",
            "verifier": {
                "type": "f2p-p2p",
                "failToPass": ["tests/test_fix.py::test_regression"],
                "passToPass": ["tests/test_existing.py::test_stable"],
                "evalSemanticsVersion": "swe-rebench-v2.1",
                "futureVerifierField": {"preserved": True},
            },
            "futureEnvironmentField": {"preserved": True},
        },
        "outcome": {
            **episode["outcome"],
            "summary": "all checks passed",
            "acceptedDiff": True,
            "testRuns": {
                "passed": 2,
                "failed": 0,
                "futureTestRunsField": {"preserved": True},
            },
            "futureOutcomeField": {"preserved": True},
        },
        "cost": {
            "durationMs": 42,
            "tokens": {
                "input": 10,
                "output": 4,
                "futureTokensField": {"preserved": True},
            },
            "usdEstimate": "0.42",
            "futureCostField": {"preserved": True},
        },
        "retention": {
            **episode["retention"],
            "futureRetentionField": {"preserved": True},
        },
        "lineage": {
            "episodeId": "episode:parent",
            "mintRef": "bafy-parent",
            "futureLineageField": {"preserved": True},
        },
        "attemptGroup": {
            "groupId": "group",
            "attemptId": "attempt",
            "relatedAttemptRefs": ["bafy-pass", "bafy-fail"],
            "groupSize": 2,
            "nPass": 1,
            "nFail": 1,
            "futureAttemptField": {"preserved": True},
        },
        "activity": {
            "searchedTerms": ["dashboard"],
            "providedRefs": ["bafy-delivered"],
            "surfacedRefs": ["bafy-delivered"],
            "fetchedRefs": ["bafy-delivered"],
            "installedSkillRefs": ["skills/testing@1"],
            "retrievalFired": True,
            "eligibleRefs": ["bafy-delivered"],
            "deliveredRefs": ["bafy-delivered"],
            "deliveryMode": "delivered",
            "deliveredContentHash": f"sha256:{'a' * 64}",
            "futureActivityField": {"preserved": True},
        },
        "eligibility": {
            "eligible": True,
            "reason": "accepted diff on a public repository",
            "checkedAt": "2026-07-20T00:00:00.123456789Z",
            "futureEligibilityField": {"preserved": True},
        },
    })
    episode["trajectory"][0].update({
        "truncatedKeys": ["attributes.private"],
        "futureStepField": {"preserved": True},
    })

    projected, _digest = skills_install._extract_trace({
        "artifacts": [_artifact("jinn.episode.v1", episode)],
    })

    assert projected["futureTopLevelField"] == {"nested": ["preserved"]}
    assert projected["environment"]["generatorModel"]["futureGeneratorField"] == {
        "preserved": True
    }
    assert projected["activity"]["futureActivityField"] == {"preserved": True}
    assert projected["eligibility"]["futureEligibilityField"] == {
        "preserved": True
    }


def test_extract_trace_accepts_reader_null_normalization_and_activity_defaults():
    episode = copy.deepcopy(_valid_episode())
    episode["session"]["parentSessionId"] = None
    episode["task"].update({
        "repositorySlug": None,
        "baseCommit": None,
        "createdAt": None,
        "instanceId": None,
    })
    episode["trajectory"][0]["truncatedKeys"] = None
    episode["environment"].update({
        "generatorModel": {
            "id": "test-model",
            "provider": None,
            "openWeights": None,
            "source": "config",
        },
        "distributionClass": None,
        "verifier": {
            "type": "none",
            "evalSemanticsVersion": None,
        },
    })
    episode["outcome"].update({
        "summary": None,
        "acceptedDiff": None,
        "testRuns": None,
    })
    episode["cost"].update({"tokens": None, "usdEstimate": None})
    episode["lineage"] = {"episodeId": "episode:parent", "mintRef": None}
    episode["attemptGroup"] = {
        "groupId": "group",
        "attemptId": "attempt",
        "groupSize": None,
        "nPass": None,
        "nFail": None,
    }
    episode["activity"] = {
        "searchedTerms": ["dashboard"],
        "providedRefs": ["bafy-delivered"],
        "deliveredContentHash": None,
    }
    episode["eligibility"] = None

    projected, _digest = skills_install._extract_trace({
        "artifacts": [_artifact("jinn.episode.v1", episode)],
    })

    assert projected["steps"][0]["truncatedKeys"] is None
    assert projected["activity"]["providedRefs"] == ["bafy-delivered"]


def test_extract_trace_reader_does_not_require_write_only_delivered_hash():
    episode = copy.deepcopy(_valid_episode())
    episode["activity"] = {
        "retrievalFired": True,
        "eligibleRefs": ["bafy-delivered"],
        "deliveredRefs": ["bafy-delivered"],
        "deliveryMode": "delivered",
    }

    projected, _digest = skills_install._extract_trace({
        "artifacts": [_artifact("jinn.episode.v1", episode)],
    })

    assert projected["activity"]["deliveryMode"] == "delivered"


@pytest.mark.parametrize(
    ("field_path", "mutate"),
    [
        ("environment", lambda episode: episode.pop("environment")),
        ("trajectory", lambda episode: episode.update({"trajectory": []})),
        (
            "session.capturedAt",
            lambda episode: episode["session"].update(
                {"capturedAt": "not-a-date"}
            ),
        ),
        (
            "session.sessionId",
            lambda episode: episode["session"].update({"sessionId": "s" * 129}),
        ),
        (
            "session.parentSessionId",
            lambda episode: episode["session"].update(
                {"parentSessionId": "s" * 129}
            ),
        ),
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
        (
            "outcome.verificationStrength",
            lambda episode: episode["outcome"].update({
                "verificationStrength": None,
                "verifiabilityTier": "tests-passed",
            }),
        ),
        (
            "outcome.testRuns.passed",
            lambda episode: episode["outcome"].update({
                "testRuns": {"passed": True, "failed": 0},
            }),
        ),
        (
            "cost.tokens.output",
            lambda episode: episode["cost"].update({
                "tokens": {"input": 0, "output": -1},
            }),
        ),
        (
            "environment.generatorModel",
            lambda episode: episode["environment"].update(
                {"generatorModel": []}
            ),
        ),
        (
            "environment.generatorModel.id",
            lambda episode: episode["environment"].update({
                "generatorModel": {"id": "", "source": "config"},
            }),
        ),
        (
            "environment.generatorModel.provider",
            lambda episode: episode["environment"].update({
                "generatorModel": {
                    "id": "model",
                    "provider": "",
                    "source": "config",
                },
            }),
        ),
        (
            "environment.generatorModel.openWeights",
            lambda episode: episode["environment"].update({
                "generatorModel": {
                    "id": "model",
                    "openWeights": "yes",
                    "source": "config",
                },
            }),
        ),
        (
            "environment.generatorModel.source",
            lambda episode: episode["environment"].update({
                "generatorModel": {"id": "model", "source": "future"},
            }),
        ),
        (
            "environment.distributionClass",
            lambda episode: episode["environment"].update(
                {"distributionClass": "private"}
            ),
        ),
        (
            "environment.verifier",
            lambda episode: episode["environment"].update({"verifier": []}),
        ),
        (
            "environment.verifier.type",
            lambda episode: episode["environment"].update({
                "verifier": {"type": "future"},
            }),
        ),
        (
            "environment.verifier.failToPass",
            lambda episode: episode["environment"].update({
                "verifier": {"type": "f2p-p2p"},
            }),
        ),
        (
            "environment.verifier.passToPass",
            lambda episode: episode["environment"].update({
                "verifier": {
                    "type": "f2p-p2p",
                    "failToPass": [],
                    "evalSemanticsVersion": "swe-rebench-v2.1",
                },
            }),
        ),
        (
            "environment.verifier.evalSemanticsVersion",
            lambda episode: episode["environment"].update({
                "verifier": {
                    "type": "f2p-p2p",
                    "failToPass": [],
                    "passToPass": [],
                },
            }),
        ),
        (
            "environment.verifier.failToPass[0]",
            lambda episode: episode["environment"].update({
                "verifier": {"type": "none", "failToPass": [""]},
            }),
        ),
        (
            "environment.verifier.evalSemanticsVersion",
            lambda episode: episode["environment"].update({
                "verifier": {"type": "none", "evalSemanticsVersion": ""},
            }),
        ),
        (
            "lineage",
            lambda episode: episode.update({"lineage": []}),
        ),
        (
            "lineage.episodeId",
            lambda episode: episode.update({
                "lineage": {"episodeId": "", "mintRef": "bafy-parent"},
            }),
        ),
        (
            "lineage.mintRef",
            lambda episode: episode.update({
                "lineage": {"episodeId": "episode:parent", "mintRef": ""},
            }),
        ),
        (
            "attemptGroup.groupSize",
            lambda episode: episode.update({
                "attemptGroup": {
                    "groupId": "group",
                    "attemptId": "attempt",
                    "groupSize": 0,
                },
            }),
        ),
        (
            "attemptGroup.nPass",
            lambda episode: episode.update({
                "attemptGroup": {
                    "groupId": "group",
                    "attemptId": "attempt",
                    "nPass": -1,
                },
            }),
        ),
        (
            "attemptGroup.relatedAttemptRefs[0]",
            lambda episode: episode.update({
                "attemptGroup": {
                    "groupId": "group",
                    "attemptId": "attempt",
                    "relatedAttemptRefs": [""],
                },
            }),
        ),
        (
            "attemptGroup.groupSize",
            lambda episode: episode.update({
                "attemptGroup": {
                    "groupId": "group",
                    "attemptId": "attempt",
                    "groupSize": 3,
                    "nPass": 1,
                    "nFail": 1,
                },
            }),
        ),
        (
            "activity",
            lambda episode: episode.update({"activity": []}),
        ),
        (
            "activity.searchedTerms",
            lambda episode: episode.update({
                "activity": {"searchedTerms": "dashboard"},
            }),
        ),
        (
            "activity.providedRefs",
            lambda episode: episode.update({
                "activity": {"providedRefs": None},
            }),
        ),
        (
            "activity.retrievalFired",
            lambda episode: episode.update({
                "activity": {"retrievalFired": "yes"},
            }),
        ),
        (
            "activity.eligibleRefs[0]",
            lambda episode: episode.update({
                "activity": {"eligibleRefs": [""]},
            }),
        ),
        (
            "activity.deliveryMode",
            lambda episode: episode.update({
                "activity": {"deliveryMode": "future"},
            }),
        ),
        (
            "activity.deliveredContentHash",
            lambda episode: episode.update({
                "activity": {"deliveredContentHash": "sha256:ABC"},
            }),
        ),
        (
            "eligibility",
            lambda episode: episode.update({"eligibility": []}),
        ),
        (
            "eligibility.eligible",
            lambda episode: episode.update({
                "eligibility": {
                    "eligible": "yes",
                    "reason": "eligible",
                    "checkedAt": "2026-07-20T00:00:00Z",
                },
            }),
        ),
        (
            "eligibility.reason",
            lambda episode: episode.update({
                "eligibility": {
                    "eligible": True,
                    "reason": "",
                    "checkedAt": "2026-07-20T00:00:00Z",
                },
            }),
        ),
        (
            "eligibility.checkedAt",
            lambda episode: episode.update({
                "eligibility": {
                    "eligible": True,
                    "reason": "eligible",
                    "checkedAt": "not-a-date",
                },
            }),
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
