"""The doctor: the {name, ok, detail, remedy} contract, incl. the outage state."""

from __future__ import annotations

import importlib
import json
import subprocess

import pytest

doctor = importlib.import_module("jinn_plugin.doctor")
runtime_pin = importlib.import_module("jinn_plugin.runtime_pin")
mcp_client = importlib.import_module("jinn_plugin.mcp_client")


class FakeClient:
    def __init__(self, report=None, error=None):
        self._report = report or {"ok": True, "version": "0.1.0", "checks": []}
        self._error = error

    def __enter__(self):
        if self._error:
            raise self._error
        return self

    def __exit__(self, *_exc):
        return None

    def call_tool(self, name, arguments):
        assert name == "health"
        return self._report


def every_check_holds_the_contract(checks):
    for check in checks:
        assert set(check) == {"name", "ok", "detail", "remedy"}
        assert isinstance(check["name"], str) and check["name"]
        assert isinstance(check["ok"], bool)
        assert isinstance(check["detail"], str) and check["detail"]
        assert check["remedy"] is None or isinstance(check["remedy"], str)
        if check["ok"]:
            continue
        assert check["remedy"] is None or check["remedy"].strip()


def test_the_fast_path_holds_the_output_contract(monkeypatch):
    monkeypatch.setattr(doctor, "_client_for_checks", lambda: FakeClient())
    checks = doctor.run_checks(full=False)
    every_check_holds_the_contract(checks)
    assert [check["name"] for check in checks] == [
        "plugin-build",
        "runtime-pin",
        "runtime-available",
        "prerequisites",
    ]


def test_the_full_run_appends_the_host_and_runtime_checks(monkeypatch):
    report = {
        "ok": False,
        "version": "0.1.0",
        "checks": [
            {"name": "corpus-mirror", "ok": True, "detail": "2 archives followed", "remedy": None},
            {"name": "corpus-index", "ok": True, "detail": "12 local, 40 public records indexed", "remedy": None},
            {"name": "corpus-trust-policy", "ok": False, "detail": "policy unresolvable", "remedy": None},
        ],
    }
    monkeypatch.setattr(doctor, "_client_for_checks", lambda: FakeClient(report))
    checks = doctor.run_checks(full=True)
    every_check_holds_the_contract(checks)
    names = [check["name"] for check in checks]
    assert "host-tools" in names
    assert "corpus-mirror" in names
    assert "corpus-index" in names
    assert "corpus-trust-policy" in names


def test_no_check_is_a_release_note(monkeypatch):
    """Every check must be able to answer differently on a different install.

    The cross-plan rule: a fact that is identical everywhere is a release note,
    not a health check. `host-provider` was one and is now a render-time
    pointer; this test is the guard that stops another creeping back in.
    """
    monkeypatch.setattr(doctor, "_client_for_checks", lambda: FakeClient())
    names = {check["name"] for check in doctor.run_checks(full=True)}
    assert "host-provider" not in names


def test_a_channel_outage_reports_a_null_remedy_not_a_no_op_command(monkeypatch, tmp_path):
    pin = runtime_pin.RuntimePin(
        package="@jinn-network/plugin-runtime",
        version="0.0.0-nonexistent",
        bin_path="runtime/node_modules/.bin/jinn-plugin-runtime",
    )
    monkeypatch.setattr(doctor.paths, "plugin_dir", lambda: tmp_path)
    monkeypatch.setattr(doctor.paths, "is_installed_plugin", lambda: True)
    monkeypatch.setattr(runtime_pin, "read_pin", lambda directory=None: pin)
    monkeypatch.setattr(
        runtime_pin,
        "resolve",
        lambda directory=None: (_ for _ in ()).throw(
            runtime_pin.RuntimePinError("not installed")
        ),
    )

    def ensure(directory=None, installer=None):
        raise runtime_pin.ChannelOutageError(
            "npm cannot supply @jinn-network/plugin-runtime@0.0.0-nonexistent: E404"
        )

    monkeypatch.setattr(runtime_pin, "ensure", ensure)
    check = doctor.check_runtime_available(client_factory=lambda: FakeClient())
    assert check["ok"] is False
    assert check["remedy"] is None
    assert "cannot supply" in check["detail"]


def test_an_ordinary_pin_failure_keeps_an_actionable_remedy(monkeypatch, tmp_path):
    (tmp_path / "runtime" / "node_modules" / "@jinn-network" / "plugin-runtime").mkdir(parents=True)
    monkeypatch.setattr(doctor.paths, "plugin_dir", lambda: tmp_path)

    def explode(directory=None):
        raise runtime_pin.RuntimePinError("pinned runtime version mismatch: expected 0.1.0")

    monkeypatch.setattr(runtime_pin, "resolve", explode)
    check = doctor.check_runtime_available(client_factory=lambda: FakeClient())
    assert check["ok"] is False
    assert check["remedy"] == "hermes plugins update jinn"


def test_a_pin_that_does_not_match_the_install_fails_before_spawn(monkeypatch, tmp_path):
    (tmp_path / "runtime" / "node_modules" / "@jinn-network" / "plugin-runtime").mkdir(parents=True)
    monkeypatch.setattr(doctor.paths, "plugin_dir", lambda: tmp_path)

    def explode(directory=None):
        raise runtime_pin.RuntimePinError("pinned runtime version mismatch: expected 0.1.0")

    monkeypatch.setattr(runtime_pin, "resolve", explode)
    check = doctor.check_runtime_pin()
    assert check["ok"] is False
    assert check["remedy"] == "hermes plugins update jinn"


def test_a_missing_install_probes_the_channel_for_an_outage(monkeypatch, tmp_path):
    pin = runtime_pin.RuntimePin(
        package="@jinn-network/plugin-runtime",
        version="0.0.0-nonexistent",
        bin_path="runtime/node_modules/.bin/jinn-plugin-runtime",
    )
    monkeypatch.setattr(doctor.paths, "plugin_dir", lambda: tmp_path)
    monkeypatch.setattr(doctor.paths, "is_installed_plugin", lambda: True)
    monkeypatch.setattr(runtime_pin, "read_pin", lambda directory=None: pin)
    monkeypatch.setattr(
        runtime_pin,
        "resolve",
        lambda directory=None: (_ for _ in ()).throw(
            runtime_pin.RuntimePinError("not installed")
        ),
    )

    def ensure(directory=None, installer=None):
        raise runtime_pin.ChannelOutageError(
            "npm cannot supply @jinn-network/plugin-runtime@0.0.0-nonexistent: E404"
        )

    monkeypatch.setattr(runtime_pin, "ensure", ensure)
    check = doctor.check_runtime_available(client_factory=lambda: FakeClient())
    assert check["ok"] is False
    assert check["remedy"] is None
    assert "cannot supply" in check["detail"]


def test_a_handshake_failure_surfaces_the_runtime_stderr(monkeypatch, tmp_path):
    pin = runtime_pin.RuntimePin(
        package="@jinn-network/plugin-runtime",
        version="0.1.0",
        bin_path="runtime/node_modules/.bin/jinn-plugin-runtime",
    )
    binary = tmp_path / pin.bin_path
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    binary.chmod(0o755)
    manifest = runtime_pin.installed_manifest_path(tmp_path, pin)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps({"name": pin.package, "version": pin.version}),
        encoding="utf-8",
    )
    (tmp_path / "runtime-pin.json").write_text(
        json.dumps({"package": pin.package, "version": pin.version, "bin": pin.bin_path}),
        encoding="utf-8",
    )
    monkeypatch.setattr(doctor.paths, "plugin_dir", lambda: tmp_path)

    factory = lambda: FakeClient(error=mcp_client.McpClientError("start-failed", "runtime exited: cannot open catalog"))
    check = doctor.check_runtime_available(client_factory=factory)
    assert check["ok"] is False
    assert "cannot open catalog" in check["detail"]
    assert check["remedy"] == "hermes plugins update jinn"


def test_a_development_override_is_reported_as_such(monkeypatch, tmp_path):
    monkeypatch.setenv("JINN_PLUGIN_RUNTIME_BIN", str(tmp_path / "runtime"))
    monkeypatch.setattr(doctor.paths, "plugin_dir", lambda: tmp_path)
    monkeypatch.setattr(runtime_pin, "read_pin", lambda directory=None: runtime_pin.RuntimePin(
        package="@jinn-network/plugin-runtime",
        version="0.1.0",
        bin_path="runtime/node_modules/.bin/jinn-plugin-runtime",
    ))
    monkeypatch.setattr(doctor, "_client_for_checks", lambda: FakeClient())
    check = doctor.check_runtime_available(client_factory=lambda: FakeClient())
    assert "development override" in check["detail"]


def test_prerequisites_fails_below_the_node_floor(monkeypatch):
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(
        doctor.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, stdout="v20.11.0\n", stderr=""),
    )
    check = doctor.check_prerequisites()
    assert check["ok"] is False
    assert check["remedy"]


def test_prerequisites_names_a_missing_node(monkeypatch):
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    check = doctor.check_prerequisites()
    assert check["ok"] is False
    assert "not found" in check["detail"]


def test_host_tools_names_a_missing_entry(monkeypatch):
    monkeypatch.setattr(doctor.host_config, "read_entry", lambda **_: None)
    check = doctor.check_host_tools()
    assert check["ok"] is False
    assert "corpus tools are not registered" in check["detail"]


def test_host_tools_names_an_orphaned_entry_after_an_uninstall(monkeypatch, tmp_path):
    monkeypatch.setattr(
        doctor.host_config,
        "read_entry",
        lambda **_: {"command": str(tmp_path / "gone" / "jinn-plugin-runtime"), "args": [], "env": {}},
    )
    check = doctor.check_host_tools()
    assert check["ok"] is False
    assert "no longer exists" in check["detail"]
    assert "mcp_servers" in check["remedy"]


def test_degraded_reason_gates_only_on_the_runtime(monkeypatch):
    checks = [
        {"name": "plugin-build", "ok": False, "detail": "dirty", "remedy": "x"},
        {"name": "runtime-available", "ok": True, "detail": "fine", "remedy": None},
    ]
    assert doctor.degraded_reason(checks) is None
    checks[1] = {"name": "runtime-available", "ok": False, "detail": "gone", "remedy": None}
    assert doctor.degraded_reason(checks) == "gone"


def test_the_doctor_never_executes_a_fix(monkeypatch):
    calls = []
    monkeypatch.setattr(doctor.subprocess, "run", lambda *args, **kwargs: calls.append(args) or subprocess.CompletedProcess(args, 0, stdout="v22.0.0\n", stderr=""))
    monkeypatch.setattr(doctor, "_client_for_checks", lambda: FakeClient())
    doctor.run_checks(full=True)
    for call in calls:
        argv = call[0]
        assert "install" not in argv
        assert "update" not in argv


def _pinned():
    class Pinned:
        argv = ("/plugins/jinn/runtime/node_modules/.bin/jinn-plugin-runtime",)
        source = "pinned"
        detail = "@jinn-network/plugin-runtime@0.1.0"
    return Pinned()
