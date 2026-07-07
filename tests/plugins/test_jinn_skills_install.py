"""/jinn skills install — the seed-consumption loop (mono #1345).

The acceptance criteria: install writes the SKILL.md where Hermes's native
loader reads it; a bad hash refuses; declined consent does NOT block
install (consuming is always allowed — consent gates contributing only);
uninstall never touches skills the user made themselves.
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
skills_install = importlib.import_module("plugins.jinn.skills_install")

REF = "bafySeedTdd"
SKILL_MD = "---\nname: test-driven-development\n---\n\n# TDD\n\nRed, green, refactor.\n"


def trace_envelope(skill_md: str = SKILL_MD, slug: str = "obra/superpowers/skills/test-driven-development") -> dict:
    return {
        "schemaVersion": "jinn.trace-envelope.v0",
        "task": {
            "summary": f"Seed import: {slug}",
            "distributionTags": ["seed-import", "superpowers", "test-driven-development"],
        },
        "steps": [
            {
                "spanId": "seed-1",
                "name": "seed:skill-md",
                "attributes": {
                    "skill.md": skill_md,
                    "seed.attribution": {"skill": slug, "source": "https://github.com/obra/superpowers", "licence": "MIT"},
                },
            }
        ],
        "provenance": "imported",
    }


def corpus_record(trace: dict, tamper_hash: bool = False) -> dict:
    content = json.dumps(trace).encode("utf-8")
    sha = hashlib.sha256(content).hexdigest()
    if tamper_hash:
        sha = "0" * 64
    return {
        "ref": REF,
        "envelope": {"solverType": "capture", "role": "capture"},
        "artifacts": [
            {
                "artifactType": "jinn.trace-envelope.v0",
                "sha256": sha,
                "contentBase64": base64.b64encode(content).decode("ascii"),
            }
        ],
    }


class CorpusGetRunner:
    def __init__(self, record: dict):
        self.record = record
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        assert argv[1:3] == ["corpus", "get"]
        return 0, json.dumps(self.record)


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    yield tmp_path


def test_install_writes_skill_md_where_hermes_loads_it(tmp_path):
    runner = CorpusGetRunner(corpus_record(trace_envelope()))
    path = skills_install.install(REF, runner=runner)
    written = Path(path)
    assert written == tmp_path / "skills" / "test-driven-development" / "SKILL.md"
    assert written.read_text() == SKILL_MD
    marker = written.parent / ".jinn-ref"
    assert json.loads(marker.read_text())["ref"] == REF


def test_bad_hash_refuses_install(tmp_path):
    runner = CorpusGetRunner(corpus_record(trace_envelope(), tamper_hash=True))
    with pytest.raises(ValueError, match="sha256 mismatch"):
        skills_install.install(REF, runner=runner)
    assert not (tmp_path / "skills").exists()


def test_declined_consent_does_not_block_install(tmp_path):
    # Consuming is always allowed — consent gates contributing only.
    consent.save_state(consent.DECLINED)
    runner = CorpusGetRunner(corpus_record(trace_envelope()))
    jinn._runner = runner
    try:
        out = jinn._handle_jinn(command_args=f"skills install {REF}")
    finally:
        jinn._runner = None
    assert "installed" in out
    assert (tmp_path / "skills" / "test-driven-development" / "SKILL.md").exists()
    assert runner.calls[0][1:3] == ["corpus", "get"]


def test_list_and_uninstall_only_touch_jinn_installed(tmp_path):
    # A skill the user made themselves — no marker.
    user_skill = tmp_path / "skills" / "my-own-skill"
    user_skill.mkdir(parents=True)
    (user_skill / "SKILL.md").write_text("# mine\n")

    runner = CorpusGetRunner(corpus_record(trace_envelope()))
    skills_install.install(REF, runner=runner)

    listed = skills_install.list_installed()
    assert [row["slug"] for row in listed] == ["test-driven-development"]

    with pytest.raises(ValueError, match="refusing"):
        skills_install.uninstall("my-own-skill")
    assert user_skill.exists()

    skills_install.uninstall("test-driven-development")
    assert not (tmp_path / "skills" / "test-driven-development").exists()


def test_slug_is_sanitised_against_traversal(tmp_path):
    evil = trace_envelope(slug="acme/skills/../../../../etc/passwd")
    runner = CorpusGetRunner(corpus_record(evil))
    path = Path(skills_install.install(REF, runner=runner))
    assert path.is_relative_to(tmp_path / "skills")
    assert ".." not in path.parts


def test_record_without_skill_md_refuses(tmp_path):
    trace = trace_envelope()
    trace["steps"][0]["attributes"].pop("skill.md")
    runner = CorpusGetRunner(corpus_record(trace))
    with pytest.raises(ValueError, match="not an installable skill"):
        skills_install.install(REF, runner=runner)
