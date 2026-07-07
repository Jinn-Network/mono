"""The no-key first-run screen must name a command that exists on PATH.

Regression for Jinn-Network/mono#1388: with no API key or model configured,
``jinn-agent chat -q`` (and the TUI, same guard) printed the upstream
first-run screen — ``Run: hermes setup``, ``hermes config set …``, "Run
'hermes setup' in an interactive terminal" — every command absent from a
jinn-agent user's PATH, and ``jinn-agent setup`` never mentioned.

Fix (two-point patch, banner.py pattern): the CLI name in the no-key screen
resolves via the active skin's branding (``cli_name``), initialised from
config on demand because the first-run guard fires before ``cli.py``'s
``init_skin_from_config``. Default-skin output is byte-identical (the
default skin declares no ``cli_name``).

Skin state is the process-global ``_active_skin`` — teardown MUST reset to
``default`` (test_jinn_branding.py precedent).
"""

from __future__ import annotations

import os
import re
import shutil as _shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SKIN_FILE = REPO_ROOT / "plugins" / "jinn" / "skin" / "jinn.yaml"

# The essential pin: the recovery command must be the fork's, never the
# upstream one, and the upstream product name must not brand the screen.
UPSTREAM_GUIDANCE = re.compile(r"\bhermes setup\b|Hermes isn't configured")


@pytest.fixture()
def jinn_skin_active(tmp_path, monkeypatch):
    """Install the repo's jinn skin into an isolated home and activate it."""
    from hermes_cli.skin_engine import set_active_skin

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    skins = tmp_path / "skins"
    skins.mkdir()
    _shutil.copy(SKIN_FILE, skins / "jinn.yaml")
    set_active_skin("jinn")
    yield
    set_active_skin("default")


@pytest.fixture()
def default_skin_active(tmp_path, monkeypatch):
    """Pin the default skin against an isolated, empty home."""
    from hermes_cli.skin_engine import set_active_skin

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    set_active_skin("default")
    yield
    set_active_skin("default")


def test_jinn_skin_declares_cli_name():
    data = yaml.safe_load(SKIN_FILE.read_text(encoding="utf-8"))
    assert (data.get("branding") or {}).get("cli_name") == "jinn-agent", (
        "the jinn skin must carry the fork's CLI command name — the no-key "
        "first-run screen derives its recovery command from it"
    )


def test_no_key_first_run_names_the_fork_setup_command(tmp_path):
    """Run the REAL entrypoint with a fresh fake HOME (no .env, no model
    block; the jinn skin activates via the entrypoint's ensure-block) and no
    provider env vars: the screen must tell the user to run 'jinn-agent
    setup' — a command that exists on their PATH — and never the upstream
    one."""
    entrypoint = REPO_ROOT / "bin" / "jinn-agent"
    if not (REPO_ROOT / "venv" / "bin" / "hermes").exists():
        pytest.skip("repo venv not built — run setup/uv pip install first")
    home = tmp_path / "home"
    home.mkdir()
    # Minimal env: no HERMES_HOME/JINN_AGENT_HOME leakage, no provider keys.
    env = {
        "HOME": str(home),
        "PATH": "/usr/bin:/bin",
        "TERM": "dumb",
    }
    result = subprocess.run(
        ["/bin/sh", str(entrypoint), "chat", "-q", "hi", "-Q"],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
        cwd=str(tmp_path),
        stdin=subprocess.DEVNULL,
    )
    out = result.stdout + result.stderr
    assert "jinn-agent setup" in out, (
        f"no-key screen never names the fork's setup command:\n{out}"
    )
    match = UPSTREAM_GUIDANCE.search(out)
    assert not match, (
        f"no-key screen still gives upstream guidance {match.group(0)!r} — "
        f"not on a jinn-agent user's PATH:\n{out}"
    )


def test_noninteractive_guidance_under_jinn_skin(jinn_skin_active, capsys):
    from hermes_cli.setup import print_noninteractive_setup_guidance

    print_noninteractive_setup_guidance("reason line")
    out = capsys.readouterr().out
    assert "jinn-agent setup" in out
    assert "jinn-agent config set model.provider custom" in out
    assert not UPSTREAM_GUIDANCE.search(out)
    assert not re.search(r"\bHermes\b", out)
    assert "⚕" not in out, "no emoji/upstream glyphs under the jinn skin"


def test_noninteractive_guidance_default_skin_unchanged(
    default_skin_active, capsys
):
    """Route-(ii) requirement: default-skin output stays byte-identical to
    upstream — pinned line-by-line against the pre-patch literals."""
    from hermes_cli.colors import Colors, color
    from hermes_cli.setup import print_noninteractive_setup_guidance

    print_noninteractive_setup_guidance()
    out = capsys.readouterr().out
    expected_header = color(
        "⚕ Hermes Setup — Non-interactive mode", Colors.CYAN, Colors.BOLD
    )
    assert expected_header in out
    for literal in (
        "Configure Hermes using environment variables or config commands:",
        "hermes config set model.provider custom",
        "hermes config set model.base_url http://localhost:8080/v1",
        "hermes config set model.default your-model-name",
        "Run 'hermes setup' in an interactive terminal to use the full wizard.",
    ):
        assert literal in out, f"default-skin output changed: {literal!r} missing"
    assert "jinn-agent" not in out


def test_cli_names_helper_degrades_to_upstream_literals(monkeypatch):
    """try/except degrade: any skin-engine failure must yield the upstream
    names, never crash the first-run guard."""
    import hermes_cli.setup as setup_mod

    def _boom(*a, **k):
        raise RuntimeError("skin engine unavailable")

    import hermes_cli.skin_engine as skin_engine

    monkeypatch.setattr(skin_engine, "get_active_skin", _boom)
    assert setup_mod._setup_cli_names() == ("hermes", "Hermes")
