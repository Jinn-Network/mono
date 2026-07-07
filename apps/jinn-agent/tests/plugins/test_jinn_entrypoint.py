"""``bin/jinn-agent`` must expose the REAL CLI surface, not the bare TUI.

Regression for the second cold-clone dogfood run (2026-07-03): the
entrypoint exec'd ``cli.py`` directly, which only carries the interactive
TUI's argument parser. Every subcommand (``setup``, ``status``, ``doctor``)
and the non-interactive single-query flags the harness spawn pattern
depends on (``chat -q <prompt> -Q --yolo``) live in the ``hermes`` console
script (``hermes_cli.main:main``). On a cold install:

  bin/jinn-agent chat -q "..." -Q   ->  ERROR: Could not consume arg: -Q
  bin/jinn-agent setup              ->  unreachable (new users cannot
                                        configure a model; first query dies
                                        with "HTTP 400: No models provided")

Mono issue: Jinn-Network/mono#1361.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = REPO_ROOT / "bin" / "jinn-agent"
SKIN_FILE = REPO_ROOT / "plugins" / "jinn" / "skin" / "jinn.yaml"


def _console_script() -> Path | None:
    """The hermes console script of whichever venv this checkout has."""
    for env_dir in ("venv", ".venv"):
        candidate = REPO_ROOT / env_dir / "bin" / "hermes"
        if candidate.exists():
            return candidate
    return None


def test_entrypoint_execs_the_console_script_not_the_bare_tui():
    script = ENTRYPOINT.read_text(encoding="utf-8")
    tail = script.rsplit("PY" + "EOF", 1)[1]  # after the config-ensure block
    assert "cli.py" not in tail.replace("hermes_cli", ""), (
        "entrypoint still execs cli.py — subcommands (setup/status) and "
        "non-interactive flags (chat -q/-Q) are unreachable"
    )
    assert "bin/hermes" in tail or "hermes_cli.main" in tail, (
        "entrypoint must dispatch through the hermes console entry "
        "(hermes_cli.main), the only surface with the full CLI"
    )


@pytest.mark.skipif(_console_script() is None, reason="no venv in this checkout")
def test_entrypoint_help_lists_the_full_cli_surface(tmp_path):
    env = dict(os.environ)
    env["JINN_AGENT_HOME"] = str(tmp_path)
    env.pop("HERMES_HOME", None)
    result = subprocess.run(
        [str(ENTRYPOINT), "--help"],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    for command in ("chat", "setup", "status"):
        assert command in result.stdout, (
            f"'{command}' missing from --help — the entrypoint is not "
            f"dispatching through the real CLI\n{result.stdout[-2000:]}"
        )


@pytest.mark.skipif(_console_script() is None, reason="no venv in this checkout")
def test_entrypoint_keeps_home_isolation(tmp_path):
    """The console-script dispatch must not lose the HERMES_HOME default."""
    env = dict(os.environ)
    env["JINN_AGENT_HOME"] = str(tmp_path)
    env.pop("HERMES_HOME", None)
    subprocess.run(
        [str(ENTRYPOINT), "--help"],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    # The config-ensure block runs against the resolved home on every
    # launch, so the isolated home must now hold the enablement.
    config = (tmp_path / "config.yaml").read_text(encoding="utf-8")
    assert "jinn" in config


# ---------------------------------------------------------------------------
# Branding install (mono#1358) — the ensure-block must also install the jinn
# skin and default the config to it, so a cold clone's first screen says
# jinn-agent instead of the upstream branding. Pattern mirrors
# tests/plugins/test_jinn_plugin_loads.py (exec the single heredoc snippet).
# ---------------------------------------------------------------------------


def _ensure_snippet() -> str:
    script = ENTRYPOINT.read_text(encoding="utf-8")
    marker = "<<'PY" + "EOF'\n"
    end = "\nPY" + "EOF"
    assert marker in script, "entrypoint lost its config-ensure block"
    return script.split(marker)[1].split(end)[0]


def _run_ensure(home: Path) -> None:
    os.environ["HERMES_HOME"] = str(home)
    try:
        exec(compile(_ensure_snippet(), "ensure", "exec"), {"__name__": "__main__"})
    except SystemExit:
        pass


def test_entrypoint_installs_skin_and_branding_config(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("JINN_AGENT_REPO", str(REPO_ROOT))

    _run_ensure(tmp_path)

    installed = tmp_path / "skins" / "jinn.yaml"
    assert installed.is_file(), "jinn skin not installed into $HERMES_HOME/skins/"
    assert installed.read_text(encoding="utf-8") == SKIN_FILE.read_text(
        encoding="utf-8"
    ), "installed skin differs from the repo copy"

    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["display"]["skin"] == "jinn"
    # Upstream's OpenClaw-residue first-run hint is meaningless on this fork.
    assert cfg["onboarding"]["seen"]["openclaw_residue_cleanup"] is True

    # Idempotent: a second run changes nothing on disk.
    config_before = (tmp_path / "config.yaml").read_text(encoding="utf-8")
    skin_before = installed.read_text(encoding="utf-8")
    _run_ensure(tmp_path)
    assert (tmp_path / "config.yaml").read_text(encoding="utf-8") == config_before
    assert installed.read_text(encoding="utf-8") == skin_before


def test_entrypoint_respects_explicit_skin_choice(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("JINN_AGENT_REPO", str(REPO_ROOT))
    (tmp_path / "config.yaml").write_text(
        yaml.safe_dump({"display": {"skin": "mono"}}), encoding="utf-8"
    )

    _run_ensure(tmp_path)

    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["display"]["skin"] == "mono", "explicit skin choice was overwritten"
    # Skin still installed (available via /skin jinn) and the flag still set.
    assert (tmp_path / "skins" / "jinn.yaml").is_file()
    assert cfg["onboarding"]["seen"]["openclaw_residue_cleanup"] is True


# ---------------------------------------------------------------------------
# Identity + home isolation (mono#1386) — first run must NOT seed the agent
# home's SOUL.md with the upstream brand identity ("You are Hermes Agent,
# ... created by Nous Research." is the live identity prompt), and must not
# create a stray ~/.hermes skeleton in the user's HOME. The ensure-block
# installs the fork-owned template plugins/jinn/soul/SOUL.md ONLY when
# SOUL.md is absent — a user's existing soul is never overwritten (unlike
# the skin sync, where the repo copy is canonical).
# ---------------------------------------------------------------------------

SOUL_TEMPLATE = REPO_ROOT / "plugins" / "jinn" / "soul" / "SOUL.md"
JINN_IDENTITY_LINE = "You are jinn-agent, an open coding harness on the Jinn network."
_BRAND_WORDS = re.compile(r"(?i)\b(hermes|nous|openclaw)\b")


def test_soul_template_carries_jinn_identity_and_no_brand_words():
    text = SOUL_TEMPLATE.read_text(encoding="utf-8")
    assert text.startswith(JINN_IDENTITY_LINE)
    assert _BRAND_WORDS.search(text) is None, "upstream brand words in the fork soul"


def test_ensure_block_seeds_jinn_soul_when_absent(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("JINN_AGENT_REPO", str(REPO_ROOT))
    _run_ensure(tmp_path)
    soul = tmp_path / "SOUL.md"
    assert soul.is_file(), "ensure-block did not seed SOUL.md into a fresh home"
    assert soul.read_text(encoding="utf-8") == SOUL_TEMPLATE.read_text(encoding="utf-8")


def test_ensure_block_never_overwrites_an_existing_soul(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("JINN_AGENT_REPO", str(REPO_ROOT))
    (tmp_path / "SOUL.md").write_text("You are my custom persona.", encoding="utf-8")
    _run_ensure(tmp_path)
    assert (tmp_path / "SOUL.md").read_text(encoding="utf-8") == "You are my custom persona."


def test_core_first_run_seeding_respects_the_jinn_soul(tmp_path):
    """The ensure-block runs BEFORE the core; the core's own first-run
    seeding (_ensure_default_soul_md) must leave the jinn soul in place."""
    sys.path.insert(0, str(REPO_ROOT))
    try:
        from hermes_cli.config import _ensure_default_soul_md
    finally:
        sys.path.remove(str(REPO_ROOT))
    (tmp_path / "SOUL.md").write_text(
        SOUL_TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8"
    )
    _ensure_default_soul_md(tmp_path)
    text = (tmp_path / "SOUL.md").read_text(encoding="utf-8")
    assert text.startswith(JINN_IDENTITY_LINE), "core seeding overwrote the jinn soul"


@pytest.mark.skipif(_console_script() is None, reason="no venv in this checkout")
def test_first_launch_isolates_home_and_seeds_jinn_identity(tmp_path):
    """First launch against a fresh fake HOME: no stray $HOME/.hermes, and
    the agent home's SOUL.md is the jinn identity, brand-word free."""
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    agent_home = tmp_path / "agent-home"
    env = dict(os.environ)
    env["HOME"] = str(fake_home)
    env["JINN_AGENT_HOME"] = str(agent_home)
    env.pop("HERMES_HOME", None)
    result = subprocess.run(
        [str(ENTRYPOINT), "--help"],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert not (fake_home / ".hermes").exists(), (
        "first launch created a stray ~/.hermes in the user's HOME"
    )
    soul = agent_home / "SOUL.md"
    assert soul.is_file(), "first launch did not seed SOUL.md in the agent home"
    text = soul.read_text(encoding="utf-8")
    assert text.startswith(JINN_IDENTITY_LINE)
    assert _BRAND_WORDS.search(text) is None


def test_entrypoint_exports_repo_and_keeps_single_heredoc():
    script = ENTRYPOINT.read_text(encoding="utf-8")
    assert 'export JINN_AGENT_REPO="$PWD"' in script, (
        "entrypoint must export JINN_AGENT_REPO so the ensure-block can find "
        "the repo's skin file"
    )
    assert script.count("<<'PY" + "EOF'") == 1, (
        "entrypoint must keep exactly one heredoc block — the snippet tests "
        "split on the single PY" + "EOF marker"
    )


# ---------------------------------------------------------------------------
# Cwd preservation (mono#1369) — the entrypoint cd's into the repo root for
# venv resolution and the ensure-block, but must return to the invoking
# directory before exec'ing the agent. Regression for the dogfood run where
# `jinn-agent chat -q "write a file ..."` from an empty work dir wrote the
# file into the repo clone instead.
#
# The test copies the real entrypoint into a fake repo layout with a stub
# `venv/bin/hermes` that prints its cwd, invokes it from a DIFFERENT temp
# directory, and asserts the agent saw the invoking directory — while the
# ensure-block still found the repo (skin installed into the temp home).
# ---------------------------------------------------------------------------


def _real_venv_python() -> Path | None:
    for env_dir in ("venv", ".venv"):
        candidate = REPO_ROOT / env_dir / "bin" / "python"
        if candidate.exists():
            return candidate
    return None


def _make_fake_repo(tmp_path: Path) -> Path:
    """Fake repo: real entrypoint text, stub hermes that prints its cwd,
    stub python delegating to the real venv python (pyyaml available),
    and the repo skin file so the ensure-block has work to do."""
    fake_repo = tmp_path / "fakerepo"
    (fake_repo / "bin").mkdir(parents=True)
    entry = fake_repo / "bin" / "jinn-agent"
    entry.write_text(ENTRYPOINT.read_text(encoding="utf-8"), encoding="utf-8")
    entry.chmod(0o755)

    venv_bin = fake_repo / "venv" / "bin"
    venv_bin.mkdir(parents=True)
    stub_hermes = venv_bin / "hermes"
    stub_hermes.write_text("#!/bin/sh\npwd\n", encoding="utf-8")
    stub_hermes.chmod(0o755)
    stub_python = venv_bin / "python"
    stub_python.write_text(
        f'#!/bin/sh\nexec "{_real_venv_python()}" "$@"\n', encoding="utf-8"
    )
    stub_python.chmod(0o755)

    skin_dest = fake_repo / "plugins" / "jinn" / "skin" / "jinn.yaml"
    skin_dest.parent.mkdir(parents=True)
    skin_dest.write_text(SKIN_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    return fake_repo


@pytest.mark.skipif(_real_venv_python() is None, reason="no venv in this checkout")
def test_entrypoint_preserves_user_cwd(tmp_path):
    fake_repo = _make_fake_repo(tmp_path)
    entry = fake_repo / "bin" / "jinn-agent"

    invoke_dir = tmp_path / "workdir"
    invoke_dir.mkdir()
    home = tmp_path / "home"

    env = dict(os.environ)
    env["JINN_AGENT_HOME"] = str(home)
    env.pop("HERMES_HOME", None)
    env.pop("JINN_AGENT_REPO", None)
    result = subprocess.run(
        [str(entry)],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
        cwd=str(invoke_dir),
    )
    assert result.returncode == 0, result.stderr[-2000:]

    printed = result.stdout.strip()
    assert Path(printed).resolve() == invoke_dir.resolve(), (
        "the agent must run in the directory jinn-agent was invoked from, "
        f"not the repo clone — got {printed!r}"
    )
    # The ensure-block still resolved the repo via JINN_AGENT_REPO.
    assert (home / "skins" / "jinn.yaml").is_file(), (
        "skin not installed — the cwd fix broke the ensure-block's "
        "repo resolution"
    )


# ---------------------------------------------------------------------------
# Symlinked invocation (mono#1377) — setup.sh creates (and advertises) a
# ~/.local/bin/jinn-agent symlink to bin/jinn-agent. The entrypoint derived
# the repo root as `cd "$(dirname "$0")/.."`; through the symlink $0 is the
# symlink path, so the "repo root" resolved to ~/.local — wrong venv lookup,
# wrong JINN_AGENT_REPO, and the python fallback died with
# ModuleNotFoundError: No module named 'hermes_cli'. The entrypoint must
# resolve $0 through symlinks (including relative targets) before deriving
# the repo root, while still running the agent in the invoking directory.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(_real_venv_python() is None, reason="no venv in this checkout")
@pytest.mark.parametrize("target_style", ["absolute", "relative"])
def test_entrypoint_resolves_symlinked_invocation(tmp_path, target_style):
    fake_repo = _make_fake_repo(tmp_path)
    entry = fake_repo / "bin" / "jinn-agent"

    # Symlink in a separate bin dir, like setup.sh's ~/.local/bin link.
    link_bin = tmp_path / "linkbin"
    link_bin.mkdir()
    link = link_bin / "jinn-agent"
    if target_style == "absolute":
        link.symlink_to(entry)
    else:
        link.symlink_to(os.path.relpath(entry, link_bin))

    invoke_dir = tmp_path / "workdir"
    invoke_dir.mkdir()
    home = tmp_path / "home"

    env = dict(os.environ)
    env["JINN_AGENT_HOME"] = str(home)
    env.pop("HERMES_HOME", None)
    env.pop("JINN_AGENT_REPO", None)
    result = subprocess.run(
        [str(link)],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
        cwd=str(invoke_dir),
    )
    assert result.returncode == 0, (
        "symlinked invocation failed — the entrypoint did not resolve $0 "
        f"through the symlink before deriving the repo root\n{result.stderr[-2000:]}"
    )

    printed = result.stdout.strip()
    assert Path(printed).resolve() == invoke_dir.resolve(), (
        "the agent must run in the directory jinn-agent was invoked from, "
        f"not the repo clone — got {printed!r}"
    )
    # The ensure-block found the real repo, not the symlink's parent.
    assert (home / "skins" / "jinn.yaml").is_file(), (
        "skin not installed — JINN_AGENT_REPO did not resolve to the repo "
        "through the symlink"
    )
