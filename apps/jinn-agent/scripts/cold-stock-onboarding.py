#!/usr/bin/env python3
"""Real stock-Hermes install, doctor, banner, and remove journey.

The surrounding cold-stock shell builds the real layer and creates a temporary
root-layout git repository from the Jinn plugin source. This driver stays on
the product boundary: stock Hermes clones that repository through ``file://``,
owns the interactive enable prompt and config write, discovers the installed
directory plugin, exposes its terminal doctor, and removes it again.
"""

from __future__ import annotations

import contextlib
import errno
import io
import os
import pty
import re
import select
import shutil
import subprocess
import time
from pathlib import Path

import yaml


ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def require_path(name: str) -> Path:
    value = os.environ.get(name, "").strip()
    assert value, f"{name} is required"
    return Path(value).resolve()


HERMES_BIN = require_path("JINN_HERMES_BIN")
PLUGIN_CHANNEL = require_path("JINN_PLUGIN_CHANNEL")
HERMES_HOME = require_path("HERMES_HOME")
REAL_LAYER_BIN = require_path("JINN_LAYER_BIN")
WORK = require_path("JINN_STAGE1_WORK")


def run_cli(*args: str, env: dict[str, str] | None = None) -> str:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    proc = subprocess.run(
        [str(HERMES_BIN), *args],
        check=False,
        capture_output=True,
        text=True,
        env=child_env,
        timeout=60,
    )
    output = "\n".join(part for part in (proc.stdout, proc.stderr) if part).strip()
    assert proc.returncode == 0, (
        f"Hermes CLI failed ({proc.returncode}): {' '.join(args)}\n{output}"
    )
    return output


def install_through_enable_prompt() -> str:
    """Install through Hermes's real TTY-only confirmation path."""
    command = [
        str(HERMES_BIN),
        "plugins",
        "install",
        PLUGIN_CHANNEL.as_uri(),
    ]
    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=os.environ.copy(),
        close_fds=True,
    )
    os.close(slave_fd)
    prompt = b"Enable 'jinn' now? [y/N]:"
    output = bytearray()
    answered = False
    deadline = time.monotonic() + 60
    try:
        while True:
            if time.monotonic() >= deadline:
                proc.kill()
                raise AssertionError(
                    f"timed out waiting for Hermes enable prompt: {output.decode(errors='replace')}"
                )
            ready, _, _ = select.select([master_fd], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError as exc:
                    if exc.errno == errno.EIO and proc.poll() is not None:
                        break
                    raise
                if not chunk:
                    break
                output.extend(chunk)
                if prompt in output and not answered:
                    os.write(master_fd, b"y\n")
                    answered = True
            if proc.poll() is not None and not ready:
                break
        return_code = proc.wait(timeout=5)
    finally:
        os.close(master_fd)

    rendered = ANSI_ESCAPE.sub("", output.decode(errors="replace")).replace("\r", "")
    assert return_code == 0, f"Hermes plugin install failed ({return_code}):\n{rendered}"
    assert answered and prompt.decode() in rendered, rendered
    assert "Plugin jinn enabled." in rendered, rendered
    return rendered


def assert_check(output: str, name: str, *, ok: bool) -> None:
    prefix = "[ok  ]" if ok else "[fail]"
    lines = output.splitlines()
    matching = [index for index, line in enumerate(lines) if line.startswith(f"{prefix} {name}:")]
    assert len(matching) == 1, f"expected one {prefix} {name} line:\n{output}"
    if not ok:
        index = matching[0]
        assert index + 1 < len(lines) and lines[index + 1].lstrip().startswith(
            "remedy:"
        ), f"missing one-line remedy after {name} failure:\n{output}"


def doctor(env: dict[str, str] | None = None) -> str:
    return run_cli("jinn-doctor", env=env)


def assert_healthy_doctor(output: str) -> None:
    for name in (
        "plugin-build",
        "layer-available",
        "layer-contract",
        "prerequisites",
    ):
        assert_check(output, name, ok=True)
    assert "[ok  ] host-provider:" in output
    assert output.splitlines()[-1] == "all checks passed."


def assert_installed_directory_plugin() -> None:
    installed = HERMES_HOME / "plugins" / "jinn"
    assert (installed / ".git").is_dir(), "Hermes did not preserve the cloned git identity"
    config = yaml.safe_load((HERMES_HOME / "config.yaml").read_text(encoding="utf-8"))
    assert "jinn" in config["plugins"]["enabled"]

    import hermes_cli.plugins as plugins_module

    manager = plugins_module.PluginManager()
    manager.discover_and_load()
    loaded = manager._plugins.get("jinn")
    assert loaded is not None and loaded.enabled, loaded
    assert loaded.manifest.source == "user"
    assert loaded.module is not None
    assert Path(loaded.module.__file__).resolve().is_relative_to(installed.resolve())

    first_session = io.StringIO()
    with contextlib.redirect_stderr(first_session):
        manager.invoke_hook(
            "on_session_start",
            session_id="cold-stock-first-session",
            cwd=str(WORK),
            platform="cli",
        )
    banner = first_session.getvalue()
    assert "jinn ready — 4 checks passed" in banner, banner
    assert "◇ corpus" in banner, banner
    assert "silence means nothing relevant yet" in banner, banner
    assert "commands: /jinn · re-check: /jinn doctor" in banner, banner


def assert_doctor_red_green_matrix() -> None:
    installed = HERMES_HOME / "plugins" / "jinn"
    healthy = doctor()
    assert_healthy_doctor(healthy)

    git_head = installed / ".git" / "HEAD"
    held_head = installed / ".git" / "HEAD.cold-stock"
    git_head.rename(held_head)
    try:
        broken = doctor()
        assert_check(broken, "plugin-build", ok=False)
    finally:
        held_head.rename(git_head)
    assert_check(doctor(), "plugin-build", ok=True)

    missing_layer = WORK / "missing-jinn-layer"
    missing = doctor(env={"JINN_LAYER_BIN": str(missing_layer)})
    assert_check(missing, "layer-available", ok=False)
    assert_check(doctor(), "layer-available", ok=True)

    mismatched_layer = WORK / "mismatched-jinn-layer"
    mismatched_layer.write_text(
        "#!/usr/bin/env python3\n"
        "import json\n"
        "print(json.dumps({'contractVersion': 999}))\n",
        encoding="utf-8",
    )
    mismatched_layer.chmod(0o755)
    mismatched = doctor(env={"JINN_LAYER_BIN": str(mismatched_layer)})
    assert_check(mismatched, "layer-available", ok=True)
    assert_check(mismatched, "layer-contract", ok=False)
    assert_check(doctor(), "layer-contract", ok=True)

    real_node = shutil.which("node")
    assert real_node, "Node 22+ is required"
    node20_dir = WORK / "node20-bin"
    node20_dir.mkdir()
    node20 = node20_dir / "node"
    node20.write_text(
        "#!/bin/sh\n"
        'if [ "${1:-}" = "--version" ]; then\n'
        "  echo v20.0.0\n"
        "  exit 0\n"
        "fi\n"
        f'exec "{real_node}" "$@"\n',
        encoding="utf-8",
    )
    node20.chmod(0o755)
    old_path = os.environ["PATH"]
    old_layer = str(REAL_LAYER_BIN)
    stale_node = doctor(
        env={
            "PATH": f"{node20_dir}{os.pathsep}{old_path}",
            "JINN_LAYER_BIN": old_layer,
        }
    )
    assert_check(stale_node, "layer-available", ok=True)
    assert_check(stale_node, "layer-contract", ok=True)
    assert_check(stale_node, "prerequisites", ok=False)
    assert_check(doctor(), "prerequisites", ok=True)


def remove_and_assert_stock_silence() -> None:
    removed = run_cli("plugins", "remove", "jinn")
    assert "Plugin jinn removed" in removed, removed
    assert not (HERMES_HOME / "plugins" / "jinn").exists()

    config = (
        yaml.safe_load((HERMES_HOME / "config.yaml").read_text(encoding="utf-8"))
        or {}
    )
    plugins = config.get("plugins") or {}
    for state_name in ("enabled", "disabled"):
        assert "jinn" not in (plugins.get(state_name) or []), (
            f"removed plugin remains in plugins.{state_name}: {plugins}"
        )
    entries = plugins.get("entries") or {}
    assert "jinn" not in entries, (
        f"removed plugin remains in plugins.entries: {plugins}"
    )

    listed = run_cli("plugins", "list", "--user", "--plain")
    assert listed == "", f"removed plugin still appears in user plugin list:\n{listed}"

    from hermes_cli.plugins import PluginManager

    manager = PluginManager()
    manager.discover_and_load()
    assert "jinn" not in manager._plugins


def main() -> None:
    assert HERMES_BIN.is_file()
    assert PLUGIN_CHANNEL.joinpath(".git").is_dir()
    assert REAL_LAYER_BIN.is_file() and os.access(REAL_LAYER_BIN, os.X_OK)
    install_through_enable_prompt()
    assert_installed_directory_plugin()
    assert_doctor_red_green_matrix()
    remove_and_assert_stock_silence()
    print("COLD STOCK ONBOARDING JOURNEY PASS")


if __name__ == "__main__":
    main()
