"""/jinn distill review + install from staging (mono #1540).

review renders the layer's staged list (name · helps · from); install moves
staged skills into $HERMES_HOME/skills via the layer (zero LLM calls) and
writes the .jinn-ref marker so list/uninstall and the marker-gated delete
guard keep working, and the payoff join (F5) has provenance to read.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
distill = importlib.import_module("plugins.jinn.distill")
skills_install = importlib.import_module("plugins.jinn.skills_install")

STAGED = [
    {
        "name": "retry-backoff-patterns",
        "description": "Use when a flaky external call needs retries. Not for: pure functions.",
        "provenance": ["local-capture:own-1", "local-capture:own-2"],
    },
    {
        "name": "vitest-fixture-hygiene",
        "description": "Use when fixtures leak state between tests. Not for: e2e suites.",
        "provenance": ["local-capture:own-3"],
    },
]


class LayerRunner:
    """Answers distill staged/install; records calls; writes installed SKILL.md files."""

    def __init__(self, staged=None, install_code: int = 0):
        self.calls: list[list[str]] = []
        self.staged = STAGED if staged is None else staged
        self.install_code = install_code

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        if argv[1:3] == ["distill", "staged"]:
            return 0, json.dumps(self.staged)
        if argv[1:3] == ["distill", "install"]:
            if self.install_code != 0:
                return self.install_code, "error: not staged: nope (staged: retry-backoff-patterns)"
            out_dir = Path(argv[argv.index("--out") + 1])
            chosen = self.staged if "--all" in argv else [s for s in self.staged if s["name"] in argv]
            installed = []
            for s in chosen:
                d = out_dir / s["name"]
                d.mkdir(parents=True, exist_ok=True)
                (d / "SKILL.md").write_text(f"# {s['name']}\n")
                installed.append({"name": s["name"], "path": str(d / "SKILL.md")})
            return 0, json.dumps({"installed": installed, "stagingDir": str(out_dir) + "-staged", "activeDir": str(out_dir)})
        if argv[1:3] == ["distill", "status"]:
            return 0, json.dumps({"mode": "local"})
        return 0, "ok"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    distill.reset()
    yield
    jinn._runner = None


def _cmd(args: str, runner) -> str:
    jinn._runner = runner
    return jinn._handle_jinn(command_args=("distill " + args).strip(), session_id="s", task_id="t")


def test_review_renders_name_helps_and_provenance():
    runner = LayerRunner()
    out = _cmd("review", runner)
    staged_calls = [c for c in runner.calls if c[1:3] == ["distill", "staged"]]
    assert staged_calls and "--out" in staged_calls[0], "review reads the staging next to the native skills dir"
    assert "retry-backoff-patterns" in out
    assert "flaky external call" in out
    assert "own-1" in out or "2 capture" in out, "provenance is shown"
    assert "/jinn distill install" in out


def test_review_with_nothing_staged_points_at_start():
    out = _cmd("review", LayerRunner(staged=[]))
    assert "nothing staged" in out.lower()
    assert "/jinn distill start" in out


def test_install_all_installs_via_the_layer_and_writes_markers():
    runner = LayerRunner()
    out = _cmd("install all", runner)
    install_calls = [c for c in runner.calls if c[1:3] == ["distill", "install"]]
    assert install_calls and "--all" in install_calls[0]
    assert "retry-backoff-patterns" in out and "vitest-fixture-hygiene" in out

    marker = skills_install.skills_dir() / "retry-backoff-patterns" / ".jinn-ref"
    data = json.loads(marker.read_text())
    assert data["ref"] == "local-distill:retry-backoff-patterns"
    assert data["provenance"] == ["local-capture:own-1", "local-capture:own-2"]
    assert data["provenance_count"] == 2

    # The marker keeps the existing list/uninstall surface working unchanged.
    slugs = [row["slug"] for row in skills_install.list_installed()]
    assert "retry-backoff-patterns" in slugs


def test_install_one_by_name():
    runner = LayerRunner()
    out = _cmd("install vitest-fixture-hygiene", runner)
    install_calls = [c for c in runner.calls if c[1:3] == ["distill", "install"]]
    assert "vitest-fixture-hygiene" in install_calls[0] and "--all" not in install_calls[0]
    assert "vitest-fixture-hygiene" in out
    assert not (skills_install.skills_dir() / "retry-backoff-patterns" / ".jinn-ref").exists()


def test_install_surfaces_the_layer_error_for_unknown_names():
    out = _cmd("install nope", LayerRunner(install_code=2))
    assert "not staged" in out
    assert "retry-backoff-patterns" in out


def test_install_without_a_target_shows_usage():
    runner = LayerRunner()
    out = _cmd("install", runner)
    assert "usage" in out.lower()
    assert [c for c in runner.calls if c[1:3] == ["distill", "install"]] == []
