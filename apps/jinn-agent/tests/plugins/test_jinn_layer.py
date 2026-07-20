"""jinn-layer wrapper argv tests (Jinn-Network/mono#1420).

The splash corpus reachability+count read depends on ``corpus_search``
emitting ``--limit`` and ``--json``. These assert the exact argv the wrapper
hands the runner (a fake callable capturing the full argv, ``binary()`` at
index 0).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from plugins.jinn import jinn_layer


def test_corpus_search_emits_limit_and_json_flags():
    captured = []

    def runner(argv):
        captured.append(argv)
        return 0, "[]"

    code, out, err = jinn_layer.corpus_search("", limit=500, as_json=True, runner=runner)
    assert code == 0
    assert out == "[]"
    assert err == ""
    assert captured[0][1:] == ["corpus", "search", "", "--limit", "500", "--json"]


def test_corpus_search_query_only_default_still_json():
    captured = []

    def runner(argv):
        captured.append(argv)
        return 0, "[]"

    jinn_layer.corpus_search("tdd", runner=runner)
    assert captured[0][1:] == ["corpus", "search", "tdd", "--limit", "500", "--json"]


def test_corpus_search_no_json_omits_flag():
    captured = []

    def runner(argv):
        captured.append(argv)
        return 0, ""

    jinn_layer.corpus_search("q", as_json=False, runner=runner)
    assert captured[0][1:] == ["corpus", "search", "q", "--limit", "500"]


def _runtime_spec(plugin_dir: Path) -> Path:
    path = plugin_dir / "layer-runtime.json"
    path.write_text(
        json.dumps(
            {
                "package": "@jinn-network/jinn-layer",
                "version": "0.1.0",
                "bin": "runtime/node_modules/.bin/jinn-layer",
            }
        ),
        encoding="utf-8",
    )
    return path


def _executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)
    package = path.parents[1] / "@jinn-network" / "jinn-layer" / "package.json"
    package.parent.mkdir(parents=True, exist_ok=True)
    package.write_text(
        json.dumps({"name": "@jinn-network/jinn-layer", "version": "0.1.0"}),
        encoding="utf-8",
    )
    return path


def test_plugin_local_pinned_artifact_wins_over_environment_and_path(
    tmp_path, monkeypatch
):
    _runtime_spec(tmp_path)
    local_bin = _executable(
        tmp_path / "runtime" / "node_modules" / ".bin" / "jinn-layer"
    )
    monkeypatch.setenv("JINN_LAYER_BIN", "/tmp/developer-layer")

    resolution = jinn_layer.resolve_binary(plugin_dir=tmp_path)

    assert resolution.argv == (str(local_bin),)
    assert resolution.source == "plugin-local"
    assert resolution.package == "@jinn-network/jinn-layer"
    assert resolution.version == "0.1.0"
    assert resolution.detail == (
        f"plugin-local @jinn-network/jinn-layer@0.1.0 ({local_bin})"
    )


def test_environment_override_is_second_when_plugin_artifact_is_absent(
    tmp_path, monkeypatch
):
    _runtime_spec(tmp_path)
    monkeypatch.setenv("JINN_LAYER_BIN", "/tmp/developer-layer")

    resolution = jinn_layer.resolve_binary(plugin_dir=tmp_path)

    assert resolution.argv == ("/tmp/developer-layer",)
    assert resolution.source == "env"
    assert "development override" in resolution.detail


def test_path_is_last_when_plugin_artifact_and_environment_are_absent(
    tmp_path, monkeypatch
):
    _runtime_spec(tmp_path)
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)

    resolution = jinn_layer.resolve_binary(plugin_dir=tmp_path)

    assert resolution.argv == ("jinn-layer",)
    assert resolution.source == "path"
    assert "development override" in resolution.detail


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable-bit contract")
def test_present_but_non_executable_plugin_artifact_fails_closed(
    tmp_path, monkeypatch
):
    _runtime_spec(tmp_path)
    local_bin = tmp_path / "runtime" / "node_modules" / ".bin" / "jinn-layer"
    local_bin.parent.mkdir(parents=True)
    local_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    local_bin.chmod(0o644)
    monkeypatch.setenv("JINN_LAYER_BIN", "/tmp/must-not-mask-broken-package")

    with pytest.raises(jinn_layer.LayerResolutionError, match="not executable"):
        jinn_layer.resolve_binary(plugin_dir=tmp_path)


def test_invalid_runtime_pin_fails_closed(tmp_path, monkeypatch):
    (tmp_path / "layer-runtime.json").write_text(
        '{"package":"@jinn-network/not-layer","version":"latest","bin":"x"}',
        encoding="utf-8",
    )
    monkeypatch.setenv("JINN_LAYER_BIN", "/tmp/must-not-mask-invalid-pin")

    with pytest.raises(jinn_layer.LayerResolutionError, match="invalid layer runtime"):
        jinn_layer.resolve_binary(plugin_dir=tmp_path)


def test_installed_runtime_version_must_match_the_plugin_pin(
    tmp_path, monkeypatch
):
    _runtime_spec(tmp_path)
    local_bin = _executable(
        tmp_path / "runtime" / "node_modules" / ".bin" / "jinn-layer"
    )
    package = local_bin.parents[1] / "@jinn-network" / "jinn-layer" / "package.json"
    package.write_text(
        json.dumps({"name": "@jinn-network/jinn-layer", "version": "0.0.9"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("JINN_LAYER_BIN", "/tmp/must-not-mask-wrong-package")

    with pytest.raises(jinn_layer.LayerResolutionError, match="version mismatch"):
        jinn_layer.resolve_binary(plugin_dir=tmp_path)


def test_runtime_bootstrap_installs_the_exact_pin_into_the_plugin(
    tmp_path, monkeypatch
):
    _runtime_spec(tmp_path)
    monkeypatch.delenv("JINN_LAYER_BIN", raising=False)
    monkeypatch.setattr(
        jinn_layer.shutil,
        "which",
        lambda name: "/usr/bin/npm" if name == "npm" else None,
    )
    calls = []

    def installer(argv, cwd):
        calls.append((argv, cwd))
        _executable(
            tmp_path / "runtime" / "node_modules" / ".bin" / "jinn-layer"
        )
        return 0, "", ""

    resolution = jinn_layer.ensure_plugin_runtime(
        plugin_dir=tmp_path,
        installer=installer,
    )

    assert resolution.source == "plugin-local"
    assert calls == [(
        [
            "/usr/bin/npm",
            "install",
            "--prefix",
            str(tmp_path / "runtime"),
            "--save-exact",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "@jinn-network/jinn-layer@0.1.0",
        ],
        tmp_path,
    )]


def test_runtime_bootstrap_never_installs_over_a_development_override(
    tmp_path, monkeypatch
):
    _runtime_spec(tmp_path)
    monkeypatch.setenv("JINN_LAYER_BIN", "/tmp/developer-layer")

    def unexpected_installer(_argv, _cwd):
        raise AssertionError("installer must not run")

    resolution = jinn_layer.ensure_plugin_runtime(
        plugin_dir=tmp_path,
        installer=unexpected_installer,
    )

    assert resolution.source == "env"
