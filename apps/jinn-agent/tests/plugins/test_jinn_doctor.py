"""Plugin doctor — checks, output contract, session-start loudness (mono #1817).

Covers the doctor module (renderer, the plugin-side checks, the
full/fast split, the first-session marker + banner) and the ``__init__.py``
wiring (session-start fast path, ``/jinn doctor``, the ``jinn-doctor`` CLI
verb, memoization drop). Layer-side probes (``corpus-reachable`` /
``corpus-content``) are issue A5's — only the ``_FULL_ONLY`` extension
point is pinned here.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import subprocess

import pytest

doctor = importlib.import_module("plugins.jinn.doctor")
jinn = importlib.import_module("plugins.jinn")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")
consent = importlib.import_module("plugins.jinn.consent")
jinn_layer = importlib.import_module("plugins.jinn.jinn_layer")


@pytest.fixture(autouse=True)
def fork_cli_name(monkeypatch):
    """This suite exercises the bundled jinn-agent host unless stated otherwise."""
    monkeypatch.setenv("JINN_CLI_NAME", "jinn-agent")


class ContractRunner:
    """Fake ``jinn_layer.Runner`` returning a full 3-tuple (code, out, err)."""

    def __init__(self, code: int = 0, output: str = '{"contractVersion":1}', err: str = "") -> None:
        self.code = code
        self.output = output
        self.err = err
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **_: object) -> tuple[int, str, str]:
        self.calls.append(argv)
        if (
            argv[1:] == ["reindex", "--dry-run", "--json"]
            and self.output == '{"contractVersion":1}'
        ):
            return 0, json.dumps({
                "status": "ok",
                "mode": "inspect",
                "indexPath": None,
                "repair": False,
                "report": {
                    "indexedEpisodes": 3,
                    "unreadableFiles": 0,
                    "unreadable": [],
                    "indexUpdated": False,
                    "mutations": [],
                },
            }), ""
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


def test_remedy_present_iff_failing(healthy_environment):
    # The output contract, checked on real run_checks output: remedy is
    # present exactly when a check fails, across healthy and broken layers.
    for runner in (ContractRunner(), ContractRunner(code=127, output="", err="nope")):
        for check in doctor.run_checks(full=True, runner=runner):
            assert ("remedy" in check) == (not check["ok"])


# ── Task 2: plugin-build ─────────────────────────────────────────────────────


def _git(repo, *args):
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        env={
            "PATH": os.environ["PATH"],
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
    assert check["remedy"] == "jinn-agent plugins update jinn"


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
    assert available["remedy"] == "jinn-agent plugins update jinn"
    assert contract["ok"] is False
    assert contract["detail"] == "not checked — layer unavailable"
    assert contract["remedy"] == "jinn-agent plugins update jinn"


def test_layer_contract_version_mismatch(monkeypatch):
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    runner = ContractRunner(output='{"contractVersion":2}')
    available, contract = doctor._check_layer(runner=runner)
    assert available["ok"] is True
    assert contract["ok"] is False
    assert "contract v2" in contract["detail"]
    assert "expected v1" in contract["detail"]
    assert contract["remedy"] == "jinn-agent plugins update jinn"


def test_layer_contract_unreadable_reply(monkeypatch):
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    runner = ContractRunner(output="not json")
    available, contract = doctor._check_layer(runner=runner)
    assert available["ok"] is True
    assert contract["ok"] is False
    assert "unreadable" in contract["detail"]
    assert contract["remedy"] == "jinn-agent plugins update jinn"


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
    assert available["remedy"] != "jinn-agent plugins update jinn"


def test_layer_checks_share_exactly_one_spawn():
    runner = ContractRunner()
    doctor._check_layer(runner=runner)
    assert len(runner.calls) == 1


def test_layer_checks_bound_the_real_contract_handshake(monkeypatch):
    calls: list[tuple[list[str], int]] = []

    def fake_default_runner(
        argv,
        cwd=None,
        input=None,
        timeout_s=jinn_layer._TIMEOUT_S,
    ):
        calls.append((argv, timeout_s))
        return 124, "", f"{argv[0]}: timed out after {timeout_s}s"

    monkeypatch.setattr(jinn_layer, "_default_runner", fake_default_runner)

    available, contract = doctor._check_layer()

    assert calls == [
        (
            [jinn_layer.binary(), "contract", "--json"],
            doctor._SUBPROCESS_TIMEOUT_S,
        )
    ]
    assert doctor._SUBPROCESS_TIMEOUT_S < jinn_layer._TIMEOUT_S
    assert available["ok"] is False
    assert available["detail"] == (
        f"{jinn_layer.binary()}: timed out after {doctor._SUBPROCESS_TIMEOUT_S}s"
    )
    assert contract["detail"] == "not checked — layer unavailable"


def test_layer_failure_detail_is_one_bounded_line(monkeypatch):
    # Raw layer stderr can be a multi-line npm/stack-trace blob; the detail
    # (and therefore _degraded and `/jinn status`) must stay single-line.
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    noisy = "npm warn deprecated\nnpm warn old\n" + "x" * 400
    available, _ = doctor._check_layer(runner=ContractRunner(code=1, output="", err=noisy))
    assert available["ok"] is False
    assert "\n" not in available["detail"]
    assert len(available["detail"]) <= 240


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
        "detail": "provider/credential sanity is owned by the host — run: jinn-agent doctor",
    }


def test_evidence_store_check_reports_readable_and_unreadable_counts():
    healthy = doctor._check_evidence_store(ContractRunner())
    assert healthy == {
        "name": "evidence-readable",
        "ok": True,
        "detail": "3 readable episode(s); 0 unreadable",
    }

    runner = ContractRunner(
        code=1,
        output=json.dumps({
            "status": "degraded",
            "mode": "inspect",
            "indexPath": None,
            "repair": False,
            "report": {
                "indexedEpisodes": 2,
                "unreadableFiles": 4,
                "unreadable": [
                    {"path": "/episodes/broken.json", "reason": "Unexpected token"},
                    {"path": "/episodes/schema.json", "reason": "invalid schema"},
                    {"path": "/episodes/link.json", "reason": "must be a regular file, not a symlink"},
                    {"path": "/episodes/dupe.json", "reason": "duplicate episodeId: same"},
                ],
                "indexUpdated": False,
                "mutations": [],
            },
        }),
    )
    broken = doctor._check_evidence_store(runner)
    assert broken == {
        "name": "evidence-readable",
        "ok": False,
        "detail": "2 readable episode(s); 4 unreadable",
        "remedy": (
            "replace unsafe symlink/non-regular sources; resolve duplicate episode IDs; "
            "fix or remove malformed/schema-invalid sources, then run: jinn-layer reindex --json"
        ),
    }


def test_evidence_store_check_gives_permission_specific_remediation():
    runner = ContractRunner(
        code=1,
        output=json.dumps({
            "status": "degraded",
            "mode": "inspect",
            "indexPath": None,
            "repair": False,
            "report": {
                "indexedEpisodes": 0,
                "unreadableFiles": 1,
                "unreadable": [{
                    "path": "/episodes/private.json",
                    "reason": "EACCES: permission denied",
                }],
                "indexUpdated": False,
                "mutations": [],
            },
        }),
    )

    check = doctor._check_evidence_store(runner)

    assert check["remedy"] == (
        "restore owner read access, then run: jinn-layer reindex --json"
    )


def test_evidence_store_check_repairs_interrupted_mutation_state():
    runner = ContractRunner(
        code=1,
        output=json.dumps({
            "status": "degraded",
            "mode": "inspect",
            "indexPath": None,
            "repair": False,
            "report": {
                "indexedEpisodes": 2,
                "unreadableFiles": 1,
                "unreadable": [{
                    "path": "/episodes/.jinn-rescue-example.txn",
                    "reason": (
                        "interrupted evidence repair state requires "
                        "jinn-layer reindex --repair --json"
                    ),
                }],
                "indexUpdated": False,
                "mutations": [],
            },
        }),
    )

    check = doctor._check_evidence_store(runner)

    assert check["remedy"] == (
        "recover interrupted evidence repair, then run: "
        "jinn-layer reindex --repair --json"
    )


def test_evidence_store_check_surfaces_an_unreadable_reply():
    runner = ContractRunner(code=0, output="not-json")
    check = doctor._check_evidence_store(runner)
    assert check["name"] == "evidence-readable"
    assert check["ok"] is False
    assert check["detail"] == "evidence readability reply unreadable"
    assert check["remedy"] == "jinn-agent plugins update jinn"


def test_evidence_store_check_rejects_a_non_inspect_or_inconsistent_envelope():
    replies = [
        {
            "status": "ok",
            "mode": "reindex",
            "indexPath": None,
            "repair": False,
            "report": {
                "indexedEpisodes": 3,
                "unreadableFiles": 0,
                "unreadable": [],
                "indexUpdated": False,
                "mutations": [],
            },
        },
        {
            "status": "ok",
            "mode": "inspect",
            "indexPath": None,
            "repair": False,
            "report": {
                "indexedEpisodes": 2,
                "unreadableFiles": 1,
                "unreadable": [],
                "indexUpdated": False,
                "mutations": [],
            },
        },
        {
            "status": "ok",
            "mode": "inspect",
            "indexPath": "/tmp/written.sqlite",
            "repair": False,
            "report": {
                "indexedEpisodes": 3,
                "unreadableFiles": 0,
                "unreadable": [],
                "indexUpdated": False,
                "mutations": [],
            },
        },
        {
            "status": "ok",
            "mode": "inspect",
            "repair": False,
            "report": {
                "indexedEpisodes": 3,
                "unreadableFiles": 0,
                "unreadable": [],
                "indexUpdated": False,
                "mutations": [],
            },
        },
        {
            "status": "ok",
            "mode": "inspect",
            "indexPath": None,
            "repair": True,
            "report": {
                "indexedEpisodes": 3,
                "unreadableFiles": 0,
                "unreadable": [],
                "indexUpdated": True,
                "mutations": [{"kind": "normalized-json"}],
            },
        },
    ]

    for reply in replies:
        check = doctor._check_evidence_store(
            ContractRunner(code=0, output=json.dumps(reply))
        )
        assert check == {
            "name": "evidence-readable",
            "ok": False,
            "detail": "evidence readability reply unreadable",
            "remedy": "jinn-agent plugins update jinn",
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
        "evidence-readable",
    ]


def test_full_only_is_the_a5_extension_seam():
    # A5's layer-side corpus probes (corpus-reachable / corpus-content)
    # append here; the seam is a plain module-level list, not inlined.
    assert isinstance(doctor._FULL_ONLY, list)
    assert doctor._check_host_provider in doctor._FULL_ONLY
    assert doctor._check_evidence_store in doctor._FULL_ONLY


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


def test_mark_first_session_done_never_raises(isolated_home, monkeypatch):
    # A read-only home must not raise into the host session-start hook —
    # the banner just repeats next session.
    def _deny(*_a, **_k):
        raise PermissionError("read-only home")

    monkeypatch.setattr(doctor.os, "open", _deny)
    doctor._mark_first_session_done()
    assert doctor._first_session_done() is False


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
        {"name": "layer-available", "ok": False, "detail": "not found", "remedy": "jinn-agent plugins update jinn"},
        *_HEALTHY[2:],
    ]
    lines = doctor.first_session_banner(failing)
    assert lines[0] == "[fail] layer-available: not found"
    assert lines[1] == "       remedy: jinn-agent plugins update jinn"
    assert lines[-1] == "commands: /jinn · re-check: /jinn doctor"
    assert len(lines) == 4


def test_degraded_reason_derives_from_layer_checks_only():
    # plugin-build and prerequisites are reports, not gates: only a failing
    # layer check disables the session-end bridge.
    checks = [
        {"name": "plugin-build", "ok": False, "detail": "fatal: broken", "remedy": "r"},
        {"name": "layer-available", "ok": True, "detail": "jinn-layer on PATH"},
        {"name": "layer-contract", "ok": False, "detail": "contract v2 (expected v1)", "remedy": "r"},
        {"name": "prerequisites", "ok": False, "detail": "v20.9.0", "remedy": "r"},
    ]
    assert doctor.degraded_reason(checks) == "contract v2 (expected v1)"
    assert doctor.degraded_reason(_HEALTHY) is None


# ── Task 8: __init__.py wiring ───────────────────────────────────────────────


@pytest.fixture()
def wired(tmp_path, monkeypatch, healthy_environment):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    capture_buffer.reset()
    jinn._reset_session_state()
    jinn._degraded = None
    jinn._runner = None
    jinn._vetoed_tasks.clear()
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


def test_session_start_first_session_failure_prints_banner_only(wired, capsys):
    # First session with a failure: the banner IS the verdict (spec §3.2) —
    # the first failure must not print twice (once in a fail loop, once in
    # the banner).
    jinn._runner = ContractRunner(code=127, output="", err="jinn-layer: not found")

    jinn._on_session_start(session_id="s1")

    err = capsys.readouterr().err
    assert err.count("[fail] layer-available: jinn-layer: not found") == 1
    assert err.rstrip("\n").splitlines() == doctor.first_session_banner(
        doctor.run_checks(
            full=False, runner=ContractRunner(code=127, output="", err="jinn-layer: not found")
        )
    )
    assert doctor._first_session_done() is True


def test_session_start_non_layer_failure_is_loud_but_keeps_bridge(wired, monkeypatch, capsys):
    # plugin-build is "a report, not a gate": a git error with a healthy
    # layer prints, but must not disable the session-end bridge.
    monkeypatch.setattr(
        doctor,
        "_check_plugin_build",
        lambda plugin_dir=None: {
            "name": "plugin-build",
            "ok": False,
            "detail": "fatal: broken",
            "remedy": "jinn-agent plugins update jinn",
        },
    )
    jinn._runner = ContractRunner()
    doctor._mark_first_session_done()

    jinn._on_session_start(session_id="s1")

    assert jinn._degraded is None
    assert "[fail] plugin-build: fatal: broken" in capsys.readouterr().err


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
    assert err.count("       remedy: jinn-agent plugins update jinn") == 4  # 2 checks x 2 sessions
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
    contract_calls = [call for call in runner.calls if call[1:] == ["contract", "--json"]]
    assert len(contract_calls) == 2


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
