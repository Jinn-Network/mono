"""``setup.sh`` must be fork-aware, not a bare pass-through to the installer.

Regression for the second cold-clone dogfood run (2026-07-03). Run as a
plain wrapper, the upstream installer:

  1. synced bundled skills into ``~/.hermes/skills/`` while the runtime
     (``bin/jinn-agent``) reads ``~/.jinn-agent`` — bundled skills were
     invisible to every session;
  2. ran ``ln -sf <repo>/venv/bin/hermes ~/.local/bin/hermes``, silently
     repointing a stock upstream install's ``hermes`` command at the fork
     (observed live on an operator machine);
  3. closed with upstream-branded next steps (``hermes setup`` / ``hermes``)
     that bypass the fork entrypoint.

Mono issue: Jinn-Network/mono#1360.

These tests run the REAL ``setup.sh`` against a stub ``setup-hermes.sh``
that mimics the two side effects that matter (records ``$HERMES_HOME``,
clobbers the ``hermes`` link) — the full installer is far too heavy for CI.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

STUB_INSTALLER = """#!/bin/sh
# Stub of the upstream installer: the side effects under test.
echo "STUB-INSTALLER-RUNNING"
echo "$HERMES_HOME" > "$(dirname "$0")/recorded-home"
mkdir -p "$(dirname "$0")/venv/bin"
printf '#!/bin/sh\\n' > "$(dirname "$0")/venv/bin/hermes"
chmod +x "$(dirname "$0")/venv/bin/hermes"
# Stub venv python: records whatever program setup.sh pipes into it
# (the tirith ensure step) so tests can assert the step ran. NO network.
cat > "$(dirname "$0")/venv/bin/python" <<'PYSTUB'
#!/bin/sh
cat > "$(cd "$(dirname "$0")/../.." && pwd)/recorded-tirith-ensure"
exit 0
PYSTUB
chmod +x "$(dirname "$0")/venv/bin/python"
mkdir -p "$HOME/.local/bin"
ln -sf "$(cd "$(dirname "$0")" && pwd)/venv/bin/hermes" "$HOME/.local/bin/hermes"
"""

# Same installer, but the venv python fails: simulates an offline install
# where the tirith download cannot complete.
STUB_INSTALLER_TIRITH_FAILS = STUB_INSTALLER.replace(
    'cat > "$(cd "$(dirname "$0")/../.." && pwd)/recorded-tirith-ensure"\nexit 0',
    "exit 1",
)
# Guard against silent drift: if the replace() target no longer matches
# STUB_INSTALLER, the failure variant would quietly test the happy path.
assert "recorded-tirith-ensure" not in STUB_INSTALLER_TIRITH_FAILS


@pytest.fixture()
def sandbox(tmp_path):
    """A fake $HOME plus a repo copy whose installer is the stub."""
    home = tmp_path / "home"
    home.mkdir()
    repo = tmp_path / "repo"
    (repo / "bin").mkdir(parents=True)
    shutil.copy2(REPO_ROOT / "setup.sh", repo / "setup.sh")
    (repo / "bin" / "jinn-agent").write_text("#!/bin/sh\n", encoding="utf-8")
    stub = repo / "setup-hermes.sh"
    stub.write_text(STUB_INSTALLER, encoding="utf-8")
    for path in (repo / "setup.sh", stub, repo / "bin" / "jinn-agent"):
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return home, repo


def _run(home: Path, repo: Path, **extra_env: str) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in ("HERMES_HOME", "JINN_AGENT_HOME")}
    env["HOME"] = str(home)
    env.update(extra_env)
    return subprocess.run(
        ["/bin/sh", str(repo / "setup.sh")],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
        cwd=str(repo),
    )


def test_installer_runs_against_the_jinn_agent_home(sandbox):
    home, repo = sandbox
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    recorded = (repo / "recorded-home").read_text().strip()
    assert recorded == str(home / ".jinn-agent")


def test_jinn_agent_home_override_is_respected(sandbox):
    home, repo = sandbox
    result = _run(home, repo, JINN_AGENT_HOME=str(home / "custom"))
    assert result.returncode == 0, result.stderr
    assert (repo / "recorded-home").read_text().strip() == str(home / "custom")


def test_preexisting_hermes_link_is_preserved(sandbox):
    home, repo = sandbox
    link_dir = home / ".local" / "bin"
    link_dir.mkdir(parents=True)
    stock_target = home / "stock-hermes-install" / "venv" / "bin" / "hermes"
    (link_dir / "hermes").symlink_to(stock_target)
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    assert (link_dir / "hermes").is_symlink()
    assert os.readlink(link_dir / "hermes") == str(stock_target), (
        "a stock install's hermes command was repointed at the fork"
    )


def test_no_hermes_link_is_left_behind_when_none_existed(sandbox):
    home, repo = sandbox
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    hermes_link = home / ".local" / "bin" / "hermes"
    assert not hermes_link.exists() and not hermes_link.is_symlink(), (
        "setup left an upstream-named command on PATH"
    )


def test_jinn_agent_command_link_is_created(sandbox):
    home, repo = sandbox
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    link = home / ".local" / "bin" / "jinn-agent"
    assert link.is_symlink()
    assert os.readlink(link) == str(repo / "bin" / "jinn-agent")


def test_hermes_link_is_restored_even_when_the_installer_fails(sandbox):
    home, repo = sandbox
    # A REAL failure: the installer dies without producing the venv.
    (repo / "setup-hermes.sh").write_text(
        '#!/bin/sh\necho "$HERMES_HOME" > "$(dirname "$0")/recorded-home"\n'
        'mkdir -p "$HOME/.local/bin"\n'
        'ln -sf /nonexistent "$HOME/.local/bin/hermes"\nexit 7\n',
        encoding="utf-8",
    )
    link_dir = home / ".local" / "bin"
    link_dir.mkdir(parents=True)
    stock_target = home / "stock" / "hermes"
    (link_dir / "hermes").symlink_to(stock_target)
    result = _run(home, repo)
    assert result.returncode != 0
    assert os.readlink(link_dir / "hermes") == str(stock_target)
    assert not (home / ".local" / "bin" / "jinn-agent").is_symlink()


def test_trailing_wizard_prompt_failure_does_not_abort_the_fork_steps(sandbox):
    """Non-interactive stdin: the upstream installer's LAST step is an
    interactive ``read`` (run-the-wizard prompt), which fails without a TTY
    and exits 1 AFTER the install is complete. The wrapper must judge
    success by the artifact the install exists to produce (venv console
    script), not by that exit code — found live on the 2026-07-03 verify
    run, where the abort skipped the jinn-agent link and next steps."""
    home, repo = sandbox
    (repo / "setup-hermes.sh").write_text(
        STUB_INSTALLER + "exit 1\n", encoding="utf-8"
    )
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    link = home / ".local" / "bin" / "jinn-agent"
    assert link.is_symlink()
    assert "jinn-agent" in result.stdout
    hermes_link = home / ".local" / "bin" / "hermes"
    assert not hermes_link.exists() and not hermes_link.is_symlink()


# --- tirith at setup time (mono#1359) -------------------------------------
# setup.sh must ensure the tirith security scanner is installed, so the
# first session does not start with "command scanning will use pattern
# matching only". Offline installs degrade with a clear message, non-fatally.


def test_setup_invokes_the_tirith_ensure_step(sandbox):
    home, repo = sandbox
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    recorded = repo / "recorded-tirith-ensure"
    assert recorded.exists(), "setup.sh never ran the tirith ensure step"
    program = recorded.read_text()
    assert "tirith" in program
    assert "_install_tirith" in program


def test_tirith_install_failure_degrades_without_failing_setup(sandbox):
    home, repo = sandbox
    (repo / "setup-hermes.sh").write_text(
        STUB_INSTALLER_TIRITH_FAILS, encoding="utf-8"
    )
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    link = home / ".local" / "bin" / "jinn-agent"
    assert link.is_symlink(), "tirith failure must not abort the fork steps"
    combined = result.stdout + result.stderr
    assert "tirith" in combined
    assert "pattern-matching" in combined, (
        "offline installs must degrade with a clear message"
    )


def _tirith_ensure_program() -> str:
    """The python program setup.sh pipes into the venv (the tirith step)."""
    text = (REPO_ROOT / "setup.sh").read_text(encoding="utf-8")
    return text.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]


def test_tirith_ensure_program_short_circuits_when_tirith_is_present(tmp_path):
    """Run the REAL heredoc program under the suite's python: with a tirith
    already on PATH it must exit 0 before reaching _install_tirith — no
    network. Also proves the program's imports actually resolve (the stub
    installer tests never execute it)."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_tirith = fake_bin / "tirith"
    fake_tirith.write_text("#!/bin/sh\n", encoding="utf-8")
    fake_tirith.chmod(0o755)
    env = dict(os.environ)
    env["PATH"] = f"{fake_bin}{os.pathsep}{env.get('PATH', '')}"
    env["HERMES_HOME"] = str(tmp_path / "hermes-home")
    result = subprocess.run(
        [sys.executable, "-"],
        input=_tirith_ensure_program(),
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, result.stderr
    from tools import tirith_security as ts

    if ts.is_platform_supported():
        assert f"tirith present: {fake_tirith}" in result.stdout
    else:
        assert "pattern matching" in result.stdout


def test_upstream_private_helper_the_ensure_step_calls_still_exists():
    """setup.sh's heredoc calls tools.tirith_security._install_tirith — an
    upstream PRIVATE helper (the public ensure_installed() is a background
    thread, no good for a blocking setup step). A rename fails soft at
    install time (degrade warning); this makes it fail LOUD in CI."""
    from tools import tirith_security as ts

    assert callable(getattr(ts, "_install_tirith", None)), (
        "upstream renamed/removed _install_tirith — update the tirith "
        "ensure heredoc in setup.sh"
    )


def test_next_steps_name_only_fork_commands(sandbox):
    home, repo = sandbox
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    assert "jinn-agent" in result.stdout
    # The wrapper's CLOSING block must not tell the user to run the upstream
    # command. Scoped to the output after "jinn-agent is installed." because
    # the pre-installer header (mono#1387) legitimately NAMES `hermes setup`
    # as an upstream command to ignore — naming is not instructing.
    closing = result.stdout.split("jinn-agent is installed.", 1)[1]
    assert "hermes setup" not in closing


# --- setup bookends (mono#1387) --------------------------------------------
# The upstream installer's output brands itself 'Hermes' and leaves
# Hermes-branded artifacts in the user's shell rc files. setup.sh must
# bookend it: a pre-installer header that frames the upstream output, and
# post-installer repairs (rc comment rebrand, fresh-bash PATH hole).

UPSTREAM_RC_COMMENT = "# Hermes Agent — ensure ~/.local/bin is on PATH"
JINN_RC_COMMENT = "# jinn-agent — ensure ~/.local/bin is on PATH"
PATH_EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"'

# Installer variant that also appends the upstream PATH block to an existing
# ~/.zshrc — mimicking upstream setup-hermes.sh's shell-config step.
STUB_INSTALLER_WRITES_RC = STUB_INSTALLER + """
if [ -f "$HOME/.zshrc" ]; then
  echo "" >> "$HOME/.zshrc"
  echo "# Hermes Agent — ensure ~/.local/bin is on PATH" >> "$HOME/.zshrc"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
fi
"""


def test_header_frames_the_installer_output(sandbox):
    """The pre-installer header must print BEFORE the upstream installer's
    own (Hermes-branded) output, and must say the upstream branding/commands
    are remapped by this fork."""
    home, repo = sandbox
    result = _run(home, repo)
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "STUB-INSTALLER-RUNNING" in out
    header_idx = out.find("upstream")
    assert header_idx != -1, "no pre-installer header in setup output"
    assert header_idx < out.find("STUB-INSTALLER-RUNNING"), (
        "the header must print before the installer runs"
    )
    header = out[: out.find("STUB-INSTALLER-RUNNING")]
    assert "Hermes" in header, "header must name the upstream branding"
    assert "jinn-agent" in header
    assert ".jinn-agent" in header, "header must name the remapped home"


def test_upstream_rc_comment_is_rebranded(sandbox):
    """The installer appends a '# Hermes Agent — …' PATH comment to the
    user's rc file; post-setup that comment must name jinn-agent."""
    home, repo = sandbox
    (repo / "setup-hermes.sh").write_text(
        STUB_INSTALLER_WRITES_RC, encoding="utf-8"
    )
    zshrc = home / ".zshrc"
    zshrc.write_text("# my dotfiles\n", encoding="utf-8")
    result = _run(home, repo, SHELL="/bin/zsh")
    assert result.returncode == 0, result.stderr
    content = zshrc.read_text(encoding="utf-8")
    assert UPSTREAM_RC_COMMENT not in content, (
        "upstream-branded rc comment survived setup"
    )
    assert JINN_RC_COMMENT in content
    assert PATH_EXPORT_LINE in content
    assert "# my dotfiles" in content, "pre-existing rc content was lost"


def test_fresh_bash_machine_gets_a_path_block(sandbox):
    """Upstream leaves a fresh bash machine with no PATH line at all. The
    wrapper must create/append the rc file matching $SHELL."""
    home, repo = sandbox
    result = _run(home, repo, SHELL="/bin/bash")
    assert result.returncode == 0, result.stderr
    bashrc = home / ".bashrc"
    assert bashrc.is_file(), "no .bashrc created on a fresh bash machine"
    content = bashrc.read_text(encoding="utf-8")
    assert JINN_RC_COMMENT in content
    assert PATH_EXPORT_LINE in content
    # The closing next steps must name the ACTUAL rc file, not ~/.zshrc.
    assert "~/.bashrc" in result.stdout
    assert "~/.zshrc" not in result.stdout


def test_fresh_unknown_shell_falls_back_to_profile(sandbox):
    home, repo = sandbox
    result = _run(home, repo, SHELL="/bin/dash")
    assert result.returncode == 0, result.stderr
    profile = home / ".profile"
    assert profile.is_file()
    content = profile.read_text(encoding="utf-8")
    assert JINN_RC_COMMENT in content
    assert PATH_EXPORT_LINE in content
    assert "~/.profile" in result.stdout


def test_rc_repairs_are_idempotent(sandbox):
    """A second setup run must not duplicate the PATH block or regress the
    rebranded comment."""
    home, repo = sandbox
    (repo / "setup-hermes.sh").write_text(
        STUB_INSTALLER_WRITES_RC, encoding="utf-8"
    )
    zshrc = home / ".zshrc"
    zshrc.write_text("", encoding="utf-8")
    first = _run(home, repo, SHELL="/bin/zsh")
    assert first.returncode == 0, first.stderr
    after_first = zshrc.read_text(encoding="utf-8")
    second = _run(home, repo, SHELL="/bin/zsh")
    assert second.returncode == 0, second.stderr
    after_second = zshrc.read_text(encoding="utf-8")
    # The stub unconditionally re-appends the upstream block when .zshrc
    # exists; the wrapper re-rebrands it, so the comment count may grow only
    # by what the stub added — the wrapper itself must add nothing new.
    assert after_second.count(JINN_RC_COMMENT) >= 1
    assert UPSTREAM_RC_COMMENT not in after_second
    # Wrapper-side append is guarded: a file already containing the PATH
    # line never gets a second wrapper-written block.
    assert after_first.count(PATH_EXPORT_LINE) == 1


def test_fresh_bash_path_block_is_not_duplicated_on_rerun(sandbox):
    home, repo = sandbox
    first = _run(home, repo, SHELL="/bin/bash")
    assert first.returncode == 0, first.stderr
    second = _run(home, repo, SHELL="/bin/bash")
    assert second.returncode == 0, second.stderr
    content = (home / ".bashrc").read_text(encoding="utf-8")
    assert content.count(JINN_RC_COMMENT) == 1
    assert content.count(PATH_EXPORT_LINE) == 1
