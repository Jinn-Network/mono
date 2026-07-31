"""The stdlib MCP client: handshake, tool calls, bounded waits, clean teardown."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

mcp_client = importlib.import_module("jinn_plugin.mcp_client")

FAKE = str(Path(__file__).resolve().parent / "fake_server.py")


def client(mode: str, **kwargs) -> "mcp_client.McpClient":
    return mcp_client.McpClient(argv=(sys.executable, FAKE, mode), env={}, **kwargs)


def test_the_handshake_negotiates_a_supported_protocol_version():
    with client("normal") as connected:
        assert connected.protocol_version in mcp_client.SUPPORTED_PROTOCOL_VERSIONS
        assert connected.server_info["name"] == "jinn"


def test_a_tool_call_returns_the_parsed_json_payload():
    with client("normal") as connected:
        payload = connected.call_tool("corpus_search", {"query": "flaky"})
        assert payload == {"echo": {"query": "flaky"}}


def test_an_unsupported_protocol_version_fails_the_handshake():
    with pytest.raises(mcp_client.McpClientError) as caught:
        client("bad-protocol").start()
    assert caught.value.code == "protocol-unsupported"


def test_a_server_that_never_starts_is_reported_not_hung():
    with pytest.raises(mcp_client.McpClientError) as caught:
        client("crash", timeout_s=3.0).start()
    assert caught.value.code in {"start-failed", "timeout"}
    assert "refuses to start" in caught.value.detail


def test_a_tool_error_result_raises_with_the_payload_intact():
    with client("tool-error") as connected:
        with pytest.raises(mcp_client.McpToolError) as caught:
            connected.call_tool("corpus_fetch", {"digest": "sha256:" + "a" * 64})
    assert caught.value.payload["error"]["code"] == "NO_LOCATION"
    assert caught.value.payload["error"]["retryable"] is True


def test_a_jsonrpc_error_is_distinguishable_from_a_tool_error():
    with client("protocol-error") as connected:
        with pytest.raises(mcp_client.McpClientError) as caught:
            connected.call_tool("nope", {})
    assert caught.value.code == "rpc-error"
    assert not isinstance(caught.value, mcp_client.McpToolError)


def test_a_slow_call_times_out_within_its_budget():
    with client("slow", timeout_s=0.5) as connected:
        with pytest.raises(mcp_client.McpClientError) as caught:
            connected.call_tool("pickup", {"message": "x"})
    assert caught.value.code == "timeout"


def test_a_chatty_server_does_not_deadlock_and_stderr_is_bounded():
    with client("chatty") as connected:
        assert connected.call_tool("health", {}) == {"echo": {}}
        assert len(connected.recent_stderr()) <= mcp_client.STDERR_RING_LINES


def test_close_is_idempotent_and_terminates_the_child():
    connected = client("normal")
    connected.start()
    connected.close()
    connected.close()
    assert connected.returncode is not None


def test_a_call_after_close_is_refused_rather_than_hanging():
    connected = client("normal")
    connected.start()
    connected.close()
    with pytest.raises(mcp_client.McpClientError) as caught:
        connected.call_tool("health", {})
    assert caught.value.code == "not-running"


def test_spawn_session_client_prefers_the_session_host_bin(tmp_path):
    import json
    import stat

    runtime_pin = importlib.import_module("jinn_plugin.runtime_pin")
    (tmp_path / "runtime-pin.json").write_text(
        json.dumps(
            {
                "package": "@jinn-network/plugin-runtime",
                "version": "0.1.0",
                "bin": "runtime/node_modules/.bin/jinn-plugin-runtime",
            }
        ),
        encoding="utf-8",
    )
    bin_dir = tmp_path / "runtime" / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    tools = bin_dir / "jinn-plugin-runtime"
    tools.write_text("#!/bin/sh\n", encoding="utf-8")
    tools.chmod(tools.stat().st_mode | stat.S_IXUSR)
    session = bin_dir / "jinn-plugin-runtime-session"
    session.write_text("#!/bin/sh\n", encoding="utf-8")
    session.chmod(session.stat().st_mode | stat.S_IXUSR)
    package_dir = tmp_path / "runtime" / "node_modules" / "@jinn-network" / "plugin-runtime"
    package_dir.mkdir(parents=True)
    (package_dir / "package.json").write_text(
        json.dumps({"name": "@jinn-network/plugin-runtime", "version": "0.1.0"}),
        encoding="utf-8",
    )

    resolution = runtime_pin.resolve(tmp_path)
    spawned = mcp_client.spawn_session_client(resolution, tmp_path / "home")
    assert spawned._argv == (str(session),)
