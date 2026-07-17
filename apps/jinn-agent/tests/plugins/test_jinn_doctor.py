"""Plugin doctor — checks, output contract, session-start loudness (mono #1817).

Covers the doctor module (renderer, the five plugin-side checks, the
full/fast split, the first-session marker + banner) and the ``__init__.py``
wiring (session-start fast path, ``/jinn doctor``, the ``jinn-doctor`` CLI
verb, memoization drop). Layer-side probes (``corpus-reachable`` /
``corpus-content``) are issue A5's — only the ``_FULL_ONLY`` extension
point is pinned here.
"""

from __future__ import annotations

import argparse
import importlib
import subprocess

import pytest

doctor = importlib.import_module("plugins.jinn.doctor")
jinn = importlib.import_module("plugins.jinn")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")
consent = importlib.import_module("plugins.jinn.consent")


class ContractRunner:
    """Fake ``jinn_layer.Runner`` returning a full 3-tuple (code, out, err)."""

    def __init__(self, code: int = 0, output: str = '{"contractVersion":1}', err: str = "") -> None:
        self.code = code
        self.output = output
        self.err = err
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **_: object) -> tuple[int, str, str]:
        self.calls.append(argv)
        return self.code, self.output, self.err


# ── Task 1: renderer ─────────────────────────────────────────────────────────


def test_render_empty_list_is_all_passed():
    assert doctor.render([]) == "all checks passed."


def test_render_passing_checks():
    checks = [
        {"name": "a", "ok": True, "detail": "fine"},
        {"name": "b", "ok": True, "detail": "also fine"},
    ]
    rendered = doctor.render(checks)
    assert rendered.splitlines() == [
        "[ok  ] a: fine",
        "[ok  ] b: also fine",
        "all checks passed.",
    ]
    assert "remedy" not in rendered


def test_render_failing_check_prints_indented_remedy_and_count():
    checks = [{"name": "x", "ok": False, "detail": "d", "remedy": "r"}]
    assert doctor.render(checks).splitlines() == [
        "[fail] x: d",
        "       remedy: r",
        "1 blocking check(s) failed.",
    ]


def test_render_counts_multiple_failures():
    checks = [
        {"name": "x", "ok": False, "detail": "d1", "remedy": "r1"},
        {"name": "y", "ok": True, "detail": "fine"},
        {"name": "z", "ok": False, "detail": "d2", "remedy": "r2"},
    ]
    assert doctor.render(checks).splitlines()[-1] == "2 blocking check(s) failed."


def test_remedy_present_iff_failing():
    checks = [
        {"name": "x", "ok": False, "detail": "d1", "remedy": "r1"},
        {"name": "y", "ok": True, "detail": "fine"},
        {"name": "z", "ok": False, "detail": "d2", "remedy": "r2"},
    ]
    for check in checks:
        assert ("remedy" in check) == (check["ok"] is False)


# ── Task 2: plugin-build ─────────────────────────────────────────────────────


def _git(repo, *args):
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        env={
            "PATH": __import__("os").environ["PATH"],
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
            "HOME": str(repo),
        },
    )


@pytest.fixture()
def git_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    (repo / "file.txt").write_text("one\n")
    _git(repo, "add", "file.txt")
    _git(repo, "commit", "-m", "one")
    return repo


def test_plugin_build_clean_git_checkout(git_repo):
    check = doctor._check_plugin_build(plugin_dir=git_repo)
    assert check["name"] == "plugin-build"
    assert check["ok"] is True
    assert "remedy" not in check
    import re

    assert re.fullmatch(r"git [0-9a-f]{7,} \(clean\)", check["detail"])


def test_plugin_build_dirty_git_checkout(git_repo):
    (git_repo / "file.txt").write_text("two\n")
    check = doctor._check_plugin_build(plugin_dir=git_repo)
    assert check["ok"] is True
    assert check["detail"].endswith("(dirty)")


def test_plugin_build_non_git_reads_plugin_yaml_version(tmp_path, monkeypatch):
    (tmp_path / "plugin.yaml").write_text("name: jinn\nversion: 0.1.0\n")

    def _no_git(*_a, **_k):  # pragma: no cover - would mean a git invocation
        raise AssertionError("git must not be invoked for a non-git install")

    monkeypatch.setattr(doctor.subprocess, "run", _no_git)
    check = doctor._check_plugin_build(plugin_dir=tmp_path)
    assert check["ok"] is True
    assert "0.1.0" in check["detail"]
    assert "remedy" not in check


def test_plugin_build_git_error_fails_with_remedy(git_repo, monkeypatch):
    def _broken_git(*_a, **_k):
        return subprocess.CompletedProcess(_a, 128, stdout="", stderr="fatal: broken")

    monkeypatch.setattr(doctor.subprocess, "run", _broken_git)
    check = doctor._check_plugin_build(plugin_dir=git_repo)
    assert check["ok"] is False
    assert check["remedy"] == "hermes plugins update jinn"


# ── Task 3: layer-available + layer-contract (single shared spawn) ───────────


def test_layer_checks_healthy(monkeypatch):
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    runner = ContractRunner()
    available, contract = doctor._check_layer(runner=runner)
    assert available["name"] == "layer-available"
    assert available["ok"] is True
    assert "remedy" not in available
    assert contract["name"] == "layer-contract"
    assert contract["ok"] is True
    assert "jinn-layer on PATH" in contract["detail"]
    assert "remedy" not in contract


def test_layer_unavailable_surfaces_stderr_remediation(monkeypatch):
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    stderr = (
        "jinn-layer: not found. Install the Jinn layer "
        "(npm install -g @jinn-network/client@canary) or set JINN_LAYER_BIN."
    )
    runner = ContractRunner(code=127, output="", err=stderr)
    available, contract = doctor._check_layer(runner=runner)
    assert available["ok"] is False
    assert available["detail"] == stderr
    assert available["remedy"] == "hermes plugins update jinn"
    assert contract["ok"] is False
    assert contract["detail"] == "not checked — layer unavailable"
    assert contract["remedy"] == "hermes plugins update jinn"


def test_layer_contract_version_mismatch(monkeypatch):
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    runner = ContractRunner(output='{"contractVersion":2}')
    available, contract = doctor._check_layer(runner=runner)
    assert available["ok"] is True
    assert contract["ok"] is False
    assert "contract v2" in contract["detail"]
    assert "expected v1" in contract["detail"]
    assert contract["remedy"] == "hermes plugins update jinn"


def test_layer_contract_unreadable_reply(monkeypatch):
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    runner = ContractRunner(output="not json")
    available, contract = doctor._check_layer(runner=runner)
    assert available["ok"] is True
    assert contract["ok"] is False
    assert "unreadable" in contract["detail"]
    assert contract["remedy"] == "hermes plugins update jinn"


def test_layer_nonzero_exit_counts_as_unavailable(monkeypatch):
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    runner = ContractRunner(code=1, output="", err="boom")
    available, contract = doctor._check_layer(runner=runner)
    assert available["ok"] is False
    assert "boom" in available["detail"]
    assert contract["ok"] is False
    assert contract["detail"] == "not checked — layer unavailable"


def test_layer_env_override_reported_and_remedy_adjusted(monkeypatch):
    monkeypatch.setenv("JINN_LAYER_BIN", "/tmp/broken/jinn-layer")
    healthy = ContractRunner()
    _, contract = doctor._check_layer(runner=healthy)
    assert contract["ok"] is True
    assert "via JINN_LAYER_BIN=/tmp/broken/jinn-layer" in contract["detail"]

    broken = ContractRunner(code=127, output="", err="not found")
    available, _ = doctor._check_layer(runner=broken)
    assert available["ok"] is False
    assert "JINN_LAYER_BIN" in available["remedy"]
    assert available["remedy"] != "hermes plugins update jinn"


def test_layer_checks_share_exactly_one_spawn():
    runner = ContractRunner()
    doctor._check_layer(runner=runner)
    assert len(runner.calls) == 1


# ── Task 4: prerequisites (node >= 22) ───────────────────────────────────────


def _fake_node(monkeypatch, version_stdout):
    monkeypatch.setattr(doctor.shutil, "which", lambda _name: "/usr/bin/node")

    def _run(argv, **_k):
        return subprocess.CompletedProcess(argv, 0, stdout=version_stdout, stderr="")

    monkeypatch.setattr(doctor.subprocess, "run", _run)


def test_prerequisites_node_missing(monkeypatch):
    monkeypatch.setattr(doctor.shutil, "which", lambda _name: None)
    check = doctor._check_prerequisites()
    assert check["name"] == "prerequisites"
    assert check["ok"] is False
    assert "not found" in check["detail"]
    assert "remedy" in check


def test_prerequisites_node_22_passes(monkeypatch):
    _fake_node(monkeypatch, "v22.1.0\n")
    check = doctor._check_prerequisites()
    assert check["ok"] is True
    assert check["detail"] == "v22.1.0"
    assert "remedy" not in check


def test_prerequisites_node_below_floor_fails_darwin(monkeypatch):
    _fake_node(monkeypatch, "v20.9.0\n")
    monkeypatch.setattr(doctor.sys, "platform", "darwin")
    check = doctor._check_prerequisites()
    assert check["ok"] is False
    assert check["detail"] == "v20.9.0"
    assert check["remedy"] == "brew install node@22"


def test_prerequisites_node_below_floor_fails_generic(monkeypatch):
    _fake_node(monkeypatch, "v20.9.0\n")
    monkeypatch.setattr(doctor.sys, "platform", "linux")
    check = doctor._check_prerequisites()
    assert check["ok"] is False
    assert check["remedy"] == "https://nodejs.org"


def test_prerequisites_node_22_boundary(monkeypatch):
    _fake_node(monkeypatch, "v22.0.0\n")
    check = doctor._check_prerequisites()
    assert check["ok"] is True


# ── Task 5: host-provider pointer ────────────────────────────────────────────


def test_host_provider_is_informational_pointer():
    check = doctor._check_host_provider()
    assert check == {
        "name": "host-provider",
        "ok": True,
        "detail": "provider/credential sanity is owned by the host — run: hermes doctor",
    }


# ── Task 6: run_checks aggregator + full/fast split ──────────────────────────


@pytest.fixture()
def healthy_environment(monkeypatch):
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    monkeypatch.setattr(
        doctor,
        "_check_plugin_build",
        lambda plugin_dir=None: {"name": "plugin-build", "ok": True, "detail": "git abc1234 (clean)"},
    )
    monkeypatch.setattr(
        doctor,
        "_check_prerequisites",
        lambda: {"name": "prerequisites", "ok": True, "detail": "v22.1.0"},
    )


def test_run_checks_fast_subset(healthy_environment):
    checks = doctor.run_checks(full=False, runner=ContractRunner())
    assert [c["name"] for c in checks] == [
        "plugin-build",
        "layer-available",
        "layer-contract",
        "prerequisites",
    ]


def test_run_checks_full_appends_host_provider(healthy_environment):
    checks = doctor.run_checks(full=True, runner=ContractRunner())
    assert [c["name"] for c in checks] == [
        "plugin-build",
        "layer-available",
        "layer-contract",
        "prerequisites",
        "host-provider",
    ]


def test_full_only_is_the_a5_extension_seam():
    # A5's layer-side corpus probes (corpus-reachable / corpus-content)
    # append here; the seam is a plain module-level list, not inlined.
    assert isinstance(doctor._FULL_ONLY, list)
    assert doctor._check_host_provider in doctor._FULL_ONLY


# ── Task 7: first-session marker + banner ────────────────────────────────────


@pytest.fixture()
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


def test_first_session_marker_path(isolated_home):
    assert (
        doctor._first_session_marker_path()
        == consent.get_hermes_home() / "jinn" / "first-session-done"
    )


def test_first_session_marker_roundtrip(isolated_home):
    assert doctor._first_session_done() is False
    doctor._mark_first_session_done()
    assert doctor._first_session_done() is True
    assert doctor._first_session_marker_path().is_file()
    # Two racing session starts must not crash either one.
    doctor._mark_first_session_done()


_HEALTHY = [
    {"name": "plugin-build", "ok": True, "detail": "git abc1234 (clean)"},
    {"name": "layer-available", "ok": True, "detail": "jinn-layer on PATH"},
    {"name": "layer-contract", "ok": True, "detail": "contract v1 (jinn-layer on PATH)"},
    {"name": "prerequisites", "ok": True, "detail": "v22.1.0"},
]


def test_banner_all_green_is_three_lines():
    lines = doctor.first_session_banner(_HEALTHY)
    assert lines == [
        "jinn ready — 4 checks passed",
        'when a first message matches prior evidence you\'ll see a "◇ corpus" line'
        " — silence means nothing relevant yet",
        "commands: /jinn · re-check: /jinn doctor",
    ]


def test_banner_with_failure_leads_with_fail_line_and_remedy():
    failing = [
        {"name": "layer-available", "ok": False, "detail": "not found", "remedy": "hermes plugins update jinn"},
        *_HEALTHY[2:],
    ]
    lines = doctor.first_session_banner(failing)
    assert lines[0] == "[fail] layer-available: not found"
    assert lines[1] == "       remedy: hermes plugins update jinn"
    assert lines[-1] == "commands: /jinn · re-check: /jinn doctor"
    assert len(lines) == 4


# ── Task 8: __init__.py wiring ───────────────────────────────────────────────


@pytest.fixture()
def wired(tmp_path, monkeypatch, healthy_environment):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    capture_buffer.reset()
    jinn._reset_session_state()
    jinn._degraded = None
    jinn._runner = None
    jinn._vetoed_tasks.clear()
    jinn._session_hint_shown.clear()
    yield tmp_path
    jinn._runner = None
    jinn._degraded = None
    jinn._reset_session_state()
    capture_buffer.reset()


def test_session_start_first_session_prints_banner_and_marks(wired, capsys):
    jinn._runner = ContractRunner()

    jinn._on_session_start(session_id="s1")

    err = capsys.readouterr().err
    assert err.rstrip("\n").splitlines() == doctor.first_session_banner(
        doctor.run_checks(full=False, runner=ContractRunner())
    )
    assert doctor._first_session_done() is True


def test_session_start_later_sessions_silent_when_healthy(wired, capsys):
    jinn._runner = ContractRunner()
    doctor._mark_first_session_done()

    jinn._on_session_start(session_id="s1")

    assert capsys.readouterr().err == ""


def test_session_start_failure_prints_every_time(wired, capsys):
    jinn._runner = ContractRunner(code=127, output="", err="jinn-layer: not found")
    doctor._mark_first_session_done()

    jinn._on_session_start(session_id="s1")
    jinn._on_session_start(session_id="s2")

    err = capsys.readouterr().err
    assert err.count("[fail] layer-available: jinn-layer: not found") == 2
    assert err.count("       remedy: hermes plugins update jinn") == 4  # 2 checks x 2 sessions
    assert jinn._degraded == "jinn-layer: not found"


def test_session_start_probes_contract_every_session(wired):
    # Migrated (inverted) from the deleted memoization test: the handshake
    # re-checks per session start now that the process-lifetime memo is gone.
    runner = ContractRunner()
    jinn._runner = runner
    doctor._mark_first_session_done()

    jinn._on_session_start(session_id="s1")
    jinn._on_session_start(session_id="s2")

    assert jinn._degraded is None
    assert len(runner.calls) == 2


def test_degraded_never_disables_python_pickup_or_local_episode_fallback(wired, monkeypatch):
    # Migrated from test_jinn_contract_handshake.py — no gate function to
    # call anymore, so the degraded state is set directly.
    runner = ContractRunner()
    jinn._runner = runner
    jinn._degraded = "contract v2 (expected v1)"
    monkeypatch.setattr(jinn.pickup, "pickup", lambda *_a, **_k: {"context": "python pickup"})
    local: list[dict] = []
    monkeypatch.setattr(jinn.distill, "write_episode_fallback", lambda episode: local.append(episode))
    monkeypatch.setattr(jinn.distill, "tee_capture", lambda *_a, **_k: None)

    result = jinn._on_pre_llm_call(
        session_id="s1", task_id="t1", user_message="fix tests", is_first_turn=True, model="m"
    )
    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "scripts/run_tests.sh tests/plugins/test_jinn_plugin.py"},
        result={"exit_code": 0},
        session_id="s1",
        task_id="t1",
        tool_call_id="c1",
    )
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True)

    assert result == {"context": "python pickup"}
    assert len(local) == 1
    assert local[0]["schemaVersion"] == "jinn.episode.v1"
    assert all(call[1:3] != ["session", "end"] for call in runner.calls)


def test_jinn_doctor_command_renders_full_run(wired):
    jinn._runner = ContractRunner()

    result = jinn._handle_jinn(command_args="doctor")

    assert result == doctor.render(doctor.run_checks(full=True, runner=ContractRunner()))
    assert "host-provider" in result
    assert jinn._degraded is None


def test_jinn_doctor_command_sets_degraded_on_failure(wired):
    jinn._runner = ContractRunner(code=127, output="", err="nope")

    jinn._handle_jinn(command_args="doctor")

    assert "bridge: degraded — nope" in jinn._handle_jinn(command_args="status")


def test_jinn_doctor_command_recovers_degraded_mid_process(wired):
    jinn._degraded = "stale reason"
    jinn._runner = ContractRunner()

    jinn._handle_jinn(command_args="doctor")

    assert jinn._degraded is None
    assert "bridge: degraded" not in jinn._handle_jinn(command_args="status")


def test_jinn_help_documents_doctor(wired):
    assert "/jinn doctor" in jinn._handle_jinn(command_args="help")


def test_cli_handler_prints_report_and_returns_zero(monkeypatch, capsys):
    canned = [{"name": "x", "ok": True, "detail": "fine"}]
    monkeypatch.setattr(doctor, "run_checks", lambda full, runner=None: canned)

    assert doctor.cli_handler(argparse.Namespace()) == 0

    out = capsys.readouterr().out
    assert "[ok  ] x: fine" in out
    assert "all checks passed." in out


def test_cli_command_registers_as_jinn_doctor_not_doctor():
    # `doctor` is a built-in hermes subcommand (hermes_cli/subcommands/
    # doctor.py); a colliding plugin name silently disables discovery of
    # every plugin CLI command. This guard pins the non-colliding verb.
    class FakeContext:
        def __init__(self) -> None:
            self.cli_commands: list[str] = []

        def register_tool(self, **_kw) -> None:
            pass

        def register_hook(self, _name, _fn) -> None:
            pass

        def register_command(self, _name, **_kw) -> None:
            pass

        def register_cli_command(self, name, **_kw) -> None:
            self.cli_commands.append(name)

    ctx = FakeContext()
    jinn.register(ctx)
    assert "jinn-doctor" in ctx.cli_commands
    assert "doctor" not in ctx.cli_commands
