"""The mcp_servers.jinn entry: written once, idempotent, scoped, honest."""

from __future__ import annotations

import importlib
from pathlib import Path

host_config = importlib.import_module("jinn_plugin.host_config")


class Resolution:
    def __init__(self, argv):
        self.argv = tuple(argv)
        self.source = "pinned"
        self.detail = "pinned"


BIN = "/home/u/.hermes/plugins/jinn/runtime/node_modules/.bin/jinn-plugin-runtime"
HOME = Path("/home/u/.hermes/jinn/runtime-home")


def test_the_entry_names_the_tools_role_and_the_shared_home():
    entry = host_config.desired_entry(Resolution([BIN]), HOME)
    assert entry["command"] == BIN
    assert entry["args"] == ["serve", "--role", "tools"]
    assert entry["env"] == {"JINN_PLUGIN_HOME": str(HOME)}
    assert entry["enabled"] is True


def test_the_entry_never_carries_credentials_or_secrets():
    entry = host_config.desired_entry(Resolution([BIN]), HOME)
    flat = repr(entry).lower()
    for forbidden in ("token", "key", "secret", "password", "authorization"):
        assert forbidden not in flat


def test_ensure_writes_the_entry_when_absent():
    config = {}
    saved = []
    action = host_config.ensure_entry(
        Resolution([BIN]), HOME, loader=lambda: config, saver=saved.append
    )
    assert action == "written"
    assert saved[0]["mcp_servers"][host_config.SERVER_KEY]["command"] == BIN


def test_ensure_is_idempotent_for_an_identical_entry():
    config = {"mcp_servers": {host_config.SERVER_KEY: host_config.desired_entry(Resolution([BIN]), HOME)}}
    saved = []
    action = host_config.ensure_entry(
        Resolution([BIN]), HOME, loader=lambda: config, saver=saved.append
    )
    assert action == "unchanged"
    assert saved == []


def test_ensure_rewrites_a_stale_command_after_a_pin_bump():
    stale = host_config.desired_entry(Resolution(["/old/path/jinn-plugin-runtime"]), HOME)
    config = {"mcp_servers": {host_config.SERVER_KEY: stale}}
    saved = []
    action = host_config.ensure_entry(
        Resolution([BIN]), HOME, loader=lambda: config, saver=saved.append
    )
    assert action == "updated"
    assert saved[0]["mcp_servers"][host_config.SERVER_KEY]["command"] == BIN


def test_ensure_preserves_every_other_server_and_every_other_key():
    config = {
        "model": {"default": "claude-opus-4.6"},
        "mcp_servers": {"filesystem": {"command": "npx", "args": ["-y", "server"]}},
    }
    saved = []
    host_config.ensure_entry(Resolution([BIN]), HOME, loader=lambda: config, saver=saved.append)
    written = saved[0]
    assert written["model"] == {"default": "claude-opus-4.6"}
    assert written["mcp_servers"]["filesystem"]["command"] == "npx"


def test_ensure_never_raises_when_the_host_config_is_unreadable():
    def explode():
        raise OSError("config.yaml is unreadable")

    assert host_config.ensure_entry(Resolution([BIN]), HOME, loader=explode, saver=lambda _: None) == "failed"


def test_ensure_never_raises_when_the_save_fails():
    def explode(_config):
        raise OSError("read-only home")

    assert host_config.ensure_entry(Resolution([BIN]), HOME, loader=dict, saver=explode) == "failed"


def test_read_entry_returns_none_when_absent():
    assert host_config.read_entry(loader=dict) is None


def test_an_env_or_path_resolution_is_not_registered_with_the_host():
    development = Resolution(["/opt/dev/jinn-plugin-runtime"])
    development.source = "env"
    saved = []
    action = host_config.ensure_entry(development, HOME, loader=dict, saver=saved.append)
    assert action == "skipped-development"
    assert saved == []
