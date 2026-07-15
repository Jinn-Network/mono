#!/usr/bin/env python3
"""Pinned-stock Hermes product journey using the installed Jinn wheel.

The surrounding shell owns the stock checkout and built artifacts. This driver
owns the user-visible lifecycle and a local HTTP stand-in for external corpus
services; the plugin and ``jinn-layer`` process bridge are the real builds.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import io
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import yaml


PINNED_HERMES = "9df5f879b4a5925c0f8f947e7e16ed8e845932c3"
CORPUS_REF = "bafyStage1TddSkill"


def require_env(name: str) -> Path:
    value = os.environ.get(name, "").strip()
    assert value, f"{name} is required"
    return Path(value).resolve()


WORK = require_env("JINN_STAGE1_WORK")
HERMES_HOME = require_env("HERMES_HOME")
LAYER_BIN = require_env("JINN_LAYER_BIN")
EPISODES_DIR = require_env("JINN_LAYER_EPISODES_DIR")
CAPTURES_DIR = require_env("JINN_LAYER_CAPTURES_DIR")
MINEABLE_DIR = require_env("JINN_MINEABLE_STATE_DIR")
LOCAL_SKILLS_DIR = require_env("JINN_LAYER_SKILLS_INSTALL_DIR")


def run(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(
        args,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def make_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    run("git", "init", "-q", cwd=path)
    run("git", "config", "user.email", "stage1@example.invalid", cwd=path)
    run("git", "config", "user.name", "Stage 1", cwd=path)
    (path / "widget.py").write_text("VALUE = 1\n", encoding="utf-8")
    run("git", "add", "widget.py", cwd=path)
    run("git", "commit", "-qm", "fixture", cwd=path)
    run(
        "git",
        "remote",
        "add",
        "origin",
        "https://github.com/acme/widget.git",
        cwd=path,
    )
    return path


class CorpusFixture:
    def __init__(self) -> None:
        self.unavailable = False
        self.requests: list[tuple[str, str]] = []
        self.endpoint = ""
        self.trace = {
            "schemaVersion": "jinn.trace-envelope.v0",
            "session": {
                "sessionId": "seed:acme/skills/test-driven-development",
                "capturedAt": "2026-07-04T00:00:00.000Z",
            },
            "task": {
                "summary": "Seed import: acme/skills/test-driven-development",
                "distributionTags": ["seed-import", "tdd", "refactoring"],
            },
            "environment": {
                "harness": {"name": "jinn-layer-seed-import", "version": "0.1.0"},
                "model": "none",
                "tools": [],
            },
            "steps": [
                {
                    "spanId": "seed-1",
                    "parentSpanId": None,
                    "name": "seed:skill-md",
                    "startTimeUnixNano": "1751587200000000000",
                    "endTimeUnixNano": "1751587200000000000",
                    "attributes": {
                        "skill.md": "# Test-driven development\n\nRed, green, refactor.\n",
                        "seed.attribution": {
                            "skill": "acme/skills/test-driven-development",
                            "source": "https://github.com/acme/skills",
                            "licence": "MIT",
                        },
                    },
                    "redactedKeys": [],
                }
            ],
            "outcome": {
                "status": "completed",
                "verifiabilityTier": "user-accepted",
            },
            "cost": {"durationMs": 0},
            "consent": {"contributionConsent": True, "scrubCompleted": True},
            "provenance": "imported",
        }
        self.trace_bytes = json.dumps(
            self.trace, separators=(",", ":"), sort_keys=True
        ).encode()
        self.trace_sha = hashlib.sha256(self.trace_bytes).hexdigest()

    def envelope(self) -> dict[str, Any]:
        return {
            "schemaVersion": "jinn.execution.v1",
            "solverType": "capture",
            "role": "solution",
            "generatedAt": 1_745_978_400,
            "task": {
                "cid": "bafyStage1Task",
                "onchainCreationTx": "0x" + "a" * 64,
                "onchainCreationBlock": 1,
                "requestId": "0x" + "b" * 64,
            },
            "participant": {
                "safeAddress": "0x" + "1" * 40,
                "agentEoa": "0x" + "2" * 40,
            },
            "window": {"startTs": 0, "endTs": 1_745_978_400},
            "executor": {
                "implName": "stage1-fixture",
                "implVersion": "1.0.0",
                "clientGitSha": "stage1",
                "codeDigest": "sha256:" + "c" * 64,
                "runtimeBundleDigest": "sha256:" + "d" * 64,
                "plugins": [],
                "signingKey": {
                    "kind": "agent-eoa",
                    "pubkey": "0x" + "e" * 128,
                },
            },
            "evidenceTier": "self-signed",
            "attestation": None,
            "trajectory": None,
            "artifacts": [
                {
                    "artifactType": "jinn.trace-envelope.v0",
                    "sha256": self.trace_sha,
                    "access": {"endpoint": self.endpoint, "priceUsdc": "0"},
                }
            ],
            "payload": {},
            "signature": {
                "algo": "secp256k1",
                "signer": "0x" + "2" * 40,
                "hash": "0x" + "e" * 64,
                "sig": "0x" + "f" * 130,
            },
        }


def start_corpus_server(fixture: CorpusFixture) -> tuple[ThreadingHTTPServer, threading.Thread]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def write_json(self, status: int, body: object) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            parsed = urlparse(self.path)
            fixture.requests.append(("GET", parsed.path))
            if parsed.path == "/ready":
                if fixture.unavailable:
                    self.write_json(503, {"ready": False})
                else:
                    self.write_json(200, {"ready": True})
                return
            if parsed.path == "/capture-meta":
                if fixture.unavailable:
                    self.write_json(503, {"error": "fixture unavailable"})
                    return
                query = " ".join(parse_qs(parsed.query).get("q", [])).lower()
                hits: list[dict[str, Any]] = []
                if "tdd-style" in query or "refactoring" in query:
                    hits.append(
                        {
                            "manifestCid": CORPUS_REF,
                            "taskSummary": "Seed import: acme/skills/test-driven-development",
                            "tags": ["seed-import", "tdd", "refactoring"],
                            "provenance": "imported",
                            "verifiabilityTier": "user-accepted",
                        }
                    )
                self.write_json(200, hits)
                return
            if parsed.path == f"/ipfs/{CORPUS_REF}":
                self.write_json(200, fixture.envelope())
                return
            if parsed.path == f"/v1/artifacts/{fixture.trace_sha}/content":
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.send_header("content-length", str(len(fixture.trace_bytes)))
                self.end_headers()
                self.wfile.write(fixture.trace_bytes)
                return
            self.write_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            parsed = urlparse(self.path)
            fixture.requests.append(("POST", parsed.path))
            length = int(self.headers.get("content-length", "0"))
            if length:
                self.rfile.read(length)
            if parsed.path == "/graphql":
                self.write_json(200, {"data": {"envelopes": {"items": []}}})
                return
            self.write_json(404, {"error": "not found"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    fixture.endpoint = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def assert_installed_product() -> None:
    assert run("git", "rev-parse", "HEAD", cwd=Path.cwd()) == PINNED_HERMES
    assert LAYER_BIN.is_file() and os.access(LAYER_BIN, os.X_OK)
    contract = json.loads(run(str(LAYER_BIN), "contract", "--json"))
    assert contract == {"contractVersion": 1}

    distribution = importlib.metadata.distribution("jinn-plugin")
    assert distribution.version == "0.1.0"
    entrypoints = importlib.metadata.entry_points(group="hermes_agent.plugins")
    assert any(ep.name == "jinn" and ep.value == "jinn_plugin" for ep in entrypoints)


def assert_disabled_is_stock_silent() -> None:
    import hermes_cli.plugins as plugins_module
    from hermes_cli.plugins import PluginManager

    disabled_home = WORK / "disabled-home"
    disabled_home.mkdir()
    (disabled_home / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"enabled": ["jinn"], "disabled": ["jinn"]}}),
        encoding="utf-8",
    )
    original_home = os.environ["HERMES_HOME"]
    os.environ["HERMES_HOME"] = str(disabled_home)
    try:
        manager = PluginManager()
        plugins_module._plugin_manager = manager
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
            io.StringIO()
        ):
            manager.discover_and_load()
        loaded = {
            (plugin.manifest.key or plugin.manifest.name): plugin
            for plugin in manager._plugins.values()
        }
        plugin = loaded.get("jinn")
        assert plugin is not None and plugin.enabled is False
        assert plugin.hooks_registered == []
        assert plugin.tools_registered == []
        assert plugin.commands_registered == []
        assert not (disabled_home / "jinn").exists()
    finally:
        os.environ["HERMES_HOME"] = original_home


def register_product(jinn: Any) -> dict[str, Any]:
    calls: dict[str, Any] = {"hooks": {}, "tools": {}, "commands": {}, "cli": {}}

    class Context:
        def register_hook(self, name: str, callback: Any) -> None:
            calls["hooks"][name] = callback

        def register_tool(self, name: str, handler: Any, **kwargs: Any) -> None:
            calls["tools"][name] = {"handler": handler, **kwargs}

        def register_command(self, name: str, handler: Any, **kwargs: Any) -> None:
            calls["commands"][name] = {"handler": handler, **kwargs}

        def register_cli_command(self, name: str, handler_fn: Any, **kwargs: Any) -> None:
            calls["cli"][name] = {"handler": handler_fn, **kwargs}

    jinn.register(Context())
    assert {
        "on_session_start",
        "pre_llm_call",
        "post_tool_call",
        "post_llm_call",
        "on_session_end",
    }.issubset(calls["hooks"])
    assert {"corpus_search", "corpus_fetch"}.issubset(calls["tools"])
    assert {"jinn", "corpus"}.issubset(calls["commands"])
    return calls


def reset_session_runtime(jinn: Any) -> None:
    jinn.buf.reset()
    jinn.distill.reset()
    jinn._reset_contract_state()
    jinn._reset_session_state()


def finish_session(
    jinn: Any,
    *,
    session_id: str,
    task_id: str,
    repo: Path,
    message: str,
    expected_pickup: bool,
    expected_publication: str,
    mutate: str | None = None,
    install_ref: bool = False,
) -> tuple[str, str | None]:
    jinn._on_session_start(session_id=session_id, cwd=str(repo), platform="cli")
    pickup_stderr = io.StringIO()
    with contextlib.redirect_stderr(pickup_stderr):
        pickup = jinn._on_pre_llm_call(
            session_id=session_id,
            task_id=task_id,
            user_message=message,
            is_first_turn=True,
            model="stage1-model",
            platform="cli",
        )
    if expected_pickup:
        assert pickup and "[jinn corpus] Relevant to this task" in pickup["context"]
        marker = pickup_stderr.getvalue()
        assert "◇ corpus" in marker and "surfaced" in marker, marker
        if install_ref:
            receipt = jinn._handle_jinn(
                f"skills install {CORPUS_REF}",
                session_id=session_id,
                task_id=task_id,
            )
            assert receipt.startswith("installed —"), receipt
    else:
        assert pickup is None

    current = jinn._handle_jinn("session", session_id=session_id, task_id=task_id)
    assert "capture active" in current.lower(), current
    assert f"publication {expected_publication}" in current, current

    if mutate:
        target = repo / "widget.py"
        target.write_text(target.read_text(encoding="utf-8") + f"{mutate}\n", encoding="utf-8")

    jinn._on_post_tool_call(
        tool_name="terminal",
        args={"command": "pytest tests/test_widget.py"},
        result={"exit_code": 0, "stdout": "1 passed"},
        session_id=session_id,
        task_id=task_id,
        tool_call_id=f"call-{session_id}",
        duration_ms=8,
    )
    jinn._on_post_llm_call(
        session_id=session_id,
        task_id=task_id,
        assistant_response="Implemented and verified the change.",
        input_tokens=21,
        output_tokens=13,
    )
    summary = io.StringIO()
    with contextlib.redirect_stderr(summary):
        jinn._on_session_end(
            session_id=session_id,
            task_id=task_id,
            completed=True,
            skills_loadout=[CORPUS_REF] if install_ref else [],
        )
    return summary.getvalue(), pickup["context"] if pickup else None


def read_store_records() -> list[dict[str, Any]]:
    store = json.loads((MINEABLE_DIR / "mineable-traces.json").read_text(encoding="utf-8"))
    assert store["schemaVersion"] == "jinn.contribution-store.v2"
    return list(store["records"].values())


def write_local_skill_provenance(session_id: str) -> None:
    """Install a deterministic output of the already-local distillation rail."""
    target = LOCAL_SKILLS_DIR / "stage1-local-pattern"
    target.mkdir(parents=True, exist_ok=True)
    target.joinpath("SKILL.md").write_text(
        """---
name: stage1-local-pattern
description: Use the locally distilled Stage 1 pattern. Not for unrelated work.
license: null
metadata:
  jinn:
    schema: jinn.skill.v1
    distribution: coding
    verifiabilityTier: user-accepted
    distilledFrom: 1
    provenance:
      - local-capture:%s
    distilledAt: "2026-07-15T00:00:00.000Z"
    skillKind: strategic-pattern
---
## When to use

Use this for the Stage 1 acceptance fixture.
"""
        % session_id,
        encoding="utf-8",
    )


def main() -> None:
    assert_installed_product()
    assert_disabled_is_stock_silent()

    import jinn_plugin as jinn

    assert Path(jinn.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
    register_product(jinn)

    fixture = CorpusFixture()
    server, thread = start_corpus_server(fixture)
    os.environ["JINN_DISCOVERY_URL"] = fixture.endpoint
    os.environ["JINN_IPFS_GATEWAY_URL"] = fixture.endpoint

    search_probe = subprocess.run(
        [str(LAYER_BIN), "corpus", "search", "tdd-style", "--json", "--limit", "3"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert search_probe.returncode == 0, (
        f"real jinn-layer corpus search failed: stdout={search_probe.stdout!r} "
        f"stderr={search_probe.stderr!r} requests={fixture.requests!r}"
    )
    search_hits = json.loads(search_probe.stdout)
    assert search_hits and search_hits[0]["ref"] == CORPUS_REF, (
        f"real jinn-layer corpus search returned no fixture: "
        f"stdout={search_probe.stdout!r} stderr={search_probe.stderr!r} "
        f"requests={fixture.requests!r}"
    )
    get_probe = subprocess.run(
        [str(LAYER_BIN), "corpus", "get", CORPUS_REF, "--json"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert get_probe.returncode == 0, (
        f"real jinn-layer corpus get failed: stdout={get_probe.stdout!r} "
        f"stderr={get_probe.stderr!r} requests={fixture.requests!r}"
    )
    assert json.loads(get_probe.stdout)["ref"] == CORPUS_REF

    legacy = HERMES_HOME / "jinn" / "pending" / "legacy-raw-trace.json"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"raw":"LEGACY_RAW_TRACE_SENTINEL"}\n', encoding="utf-8")

    work_repo = make_repo(WORK / "oss-work")
    clean_repo = make_repo(WORK / "oss-clean")
    try:
        reset_session_runtime(jinn)
        jinn.consent.save_state(False, previewed=False)
        share_off_summary, _ = finish_session(
            jinn,
            session_id="stage1-share-off",
            task_id="task-share-off",
            repo=work_repo,
            message="Tdd-style refactoring for this widget",
            expected_pickup=True,
            expected_publication="OFF",
            mutate="SECRET_ACCEPTED_DIFF_OFF = True",
            install_ref=True,
        )
        assert "captured" in share_off_summary.lower()
        assert "contribution recorded" in share_off_summary.lower(), share_off_summary
        assert list(CAPTURES_DIR.glob("*.json")), "local distillation tee missing"
        write_local_skill_provenance("stage1-share-off")

        jinn.consent.save_state(True, previewed=False)
        share_on_summary, _ = finish_session(
            jinn,
            session_id="stage1-share-on",
            task_id="task-share-on",
            repo=work_repo,
            message="Investigate quasar unobtainium",
            expected_pickup=False,
            expected_publication="ON",
            mutate="SECRET_ACCEPTED_DIFF_ON = True",
        )
        assert "nothing relevant found" in share_on_summary.lower()
        records_before_preview = read_store_records()
        share_on = next(
            row for row in records_before_preview if row["candidate"]["publishMinedTasksConsent"]
        )
        assert share_on["publicationState"] == "preview-required"
        assert "preview-required" in jinn._handle_jinn("history").lower()

        preview = jinn._handle_jinn("preview")
        assert "preview acknowledged" in preview.lower()
        assert all(
            method != "POST" or path == "/graphql"
            for method, path in fixture.requests
        ), f"publication happened before the task-creator ran: {fixture.requests!r}"
        records_after_preview = read_store_records()
        assert next(
            row for row in records_after_preview if row["recordId"] == share_on["recordId"]
        )["publicationState"] == "queued"
        history_after_preview = jinn._handle_jinn("history")
        assert "queued" in history_after_preview.lower()
        assert "stage1-local-pattern" in history_after_preview, history_after_preview

        fixture.unavailable = True
        unavailable_summary, _ = finish_session(
            jinn,
            session_id="stage1-corpus-unavailable",
            task_id="task-corpus-unavailable",
            repo=clean_repo,
            message="Offline corpus investigation",
            expected_pickup=False,
            expected_publication="ON",
        )
        fixture.unavailable = False
        assert "nothing relevant found" in unavailable_summary.lower()

        real_layer = os.environ["JINN_LAYER_BIN"]
        os.environ["JINN_LAYER_BIN"] = str(WORK / "missing-jinn-layer")
        reset_session_runtime(jinn)
        missing_summary, _ = finish_session(
            jinn,
            session_id="stage1-missing-layer",
            task_id="task-missing-layer",
            repo=clean_repo,
            message="Preserve local capture",
            expected_pickup=False,
            expected_publication="ON",
        )
        assert "captured locally" in missing_summary.lower()
        assert "process bridge degraded" in missing_summary.lower()
        os.environ["JINN_LAYER_BIN"] = real_layer

        class IncompatibleRunner:
            def __call__(
                self, argv: list[str], *, input: str | None = None
            ) -> tuple[int, str]:
                del input
                if argv[1:] == ["contract", "--json"]:
                    return 0, '{"contractVersion":999}'
                return 1, "incompatible layer"

        jinn._runner = IncompatibleRunner()
        reset_session_runtime(jinn)
        incompatible_summary, _ = finish_session(
            jinn,
            session_id="stage1-incompatible-layer",
            task_id="task-incompatible-layer",
            repo=clean_repo,
            message="Preserve incompatible capture",
            expected_pickup=False,
            expected_publication="ON",
        )
        assert "captured locally" in incompatible_summary.lower()
        assert "process bridge degraded" in incompatible_summary.lower()
        jinn._runner = None

        assert legacy.read_text(encoding="utf-8") == '{"raw":"LEGACY_RAW_TRACE_SENTINEL"}\n'
        episodes = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(EPISODES_DIR.glob("*.episode.json"))
        ]
        assert len(episodes) >= 5
        for episode in episodes:
            assert episode["schemaVersion"] == "jinn.episode.v1"
            assert episode["episodeId"]
            assert episode["session"]["capturedAt"].endswith("Z")
            assert episode["trajectory"]
            assert all(str(span["startTimeUnixNano"]).isdigit() for span in episode["trajectory"])

        records = read_store_records()
        assert len(records) == 2, records
        episode_ids = {episode["episodeId"] for episode in episodes}
        assert {row["candidate"]["sourceId"] for row in records}.issubset(episode_ids)
        assert any(not row["candidate"]["publishMinedTasksConsent"] for row in records)
        assert any(row["candidate"]["publishMinedTasksConsent"] for row in records)

        result = {
            "episodeIds": sorted(episode_ids),
            "sessions": [
                {
                    "episodeId": episode["episodeId"],
                    "sessionId": episode["session"]["sessionId"],
                    "capturedAt": episode["session"]["capturedAt"],
                }
                for episode in episodes
            ],
            "shareOffRecordId": next(
                row["recordId"]
                for row in records
                if not row["candidate"]["publishMinedTasksConsent"]
            ),
            "shareOnRecordId": next(
                row["recordId"]
                for row in records
                if row["candidate"]["publishMinedTasksConsent"]
            ),
            "legacyPending": str(legacy),
        }
        (WORK / "stock-product-result.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
    finally:
        jinn._runner = None
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    print("STOCK PRODUCT JOURNEY PASS")


if __name__ == "__main__":
    main()
