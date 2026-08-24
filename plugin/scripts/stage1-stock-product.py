#!/usr/bin/env python3
"""Pinned-stock Hermes product journey using the installed Jinn wheel.

The surrounding shell owns the stock checkout and built artifacts. This driver
owns the user-visible lifecycle and a local HTTP stand-in for external corpus
services; the plugin and ``jinn-layer`` process bridge are the real builds.

Stage 1 rescope (R5, closes #1774): the corpus fixture serves the R4 seed set
(packages/layer/fixtures/stage1-seeds/) instead of one
hand-written skill trace — the real built `jinn-layer` performs search, get,
and evidence-first packet projection against it (no plugin stubs). Scenarios
follow the rescope plan §4.5. The Stage 2 parked-era amendment keeps local
capture, candidate recording, and distillation live while exercising no
consent, preview, or publication surface.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import io
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import yaml


PINNED_HERMES = "9df5f879b4a5925c0f8f947e7e16ed8e845932c3"

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_FIXTURES_DIR = REPO_ROOT / "packages" / "layer" / "fixtures" / "stage1-seeds"

# The five curated Stage 1 seed fixtures (rescope R4, #1771 / PR #1779),
# identified by filename stem. Refs below are this driver's own stand-in
# CIDs — deterministic, not real IPFS content addresses.
SOURCE_FIXTURE = "source-dashboard-flake"
DISTRACTOR_SAME_REPO = "distractor-operator-claims"
DISTRACTOR_OTHER_DOMAIN = "distractor-sympy-printing"
DISTRACTOR_SKILL = "distractor-skill-tdd"
DISTRACTOR_SKILL_DUP = "distractor-skill-tdd-dup"


def _to_ref(stem: str) -> str:
    """Deterministic stand-in CID from a fixture filename stem."""
    parts = re.split(r"[-_]", stem)
    return "bafyStage1" + "".join(p.capitalize() for p in parts if p)


SOURCE_REF = _to_ref(SOURCE_FIXTURE)
DISTRACTOR_SAME_REPO_REF = _to_ref(DISTRACTOR_SAME_REPO)
DISTRACTOR_OTHER_DOMAIN_REF = _to_ref(DISTRACTOR_OTHER_DOMAIN)
DISTRACTOR_SKILL_REF = _to_ref(DISTRACTOR_SKILL)
DISTRACTOR_SKILL_DUP_REF = _to_ref(DISTRACTOR_SKILL_DUP)

# A distinctive, verbatim excerpt line from the source fixture's "fix" step
# (packages/layer/fixtures/stage1-seeds/source-dashboard-flake.episode.json)
# that is NOT one of the scenario-1 message's derived search terms — proves
# the injection carries real content, not metadata (rescope plan §4.5 item 1).
SOURCE_DISTINCTIVE_CONTENT = "apiMocks.getStatus"

# Scenario 1/2 message (mono #1786): representative multi-sentence prose —
# every sentence ends with a period, like real task messages do — sharing
# vocabulary with the source fixture's tags (dashboard, vitest,
# version-status) and taskSummary without quoting its sentences verbatim.
# Deliberately NOT the old single-run-on-sentence message: this one carries
# four sentence-final periods ("again.", "out.", "holds.", "green.") plus
# one real identifier ("version-status"), so it doubles as a regression
# canary for #1786 — verified empirically (built dist, real
# deriveSearchTerms/scoreKnowledgeHit):
#   - fixed cleanWord: terms = ["version-status", "acme/widget", "dashboard",
#     "confirm", "vitest", "racing"]; source scores 3 (>= the floor of 2);
#     both non-skill distractors score 0.
#   - pre-#1786-fix cleanWord: the four punctuation artifacts fill the
#     6-term budget in the identifier-shaped pass alone (`again.`, `out.`,
#     `holds.`, `green.` plus `version-status`, then the repository slug) —
#     `dashboard` never reaches the remainder bucket, so the source scores
#     only 1 (< the floor) and the gate fails. A #1786 regression trips this
#     gate instead of hiding behind a message that happens not to exercise it.
TARGET_TASK_MESSAGE = (
    "The dashboard vitest suite is flaky again. It keeps racing the "
    "version-status check and timing out. Track down the root cause and "
    "confirm the fix holds. Report back once the suite is green."
)

# Mono #1792 acceptance: only ``dashboard`` occurs in the source record's
# searchable summary/tags (metadata score 1). ``apiMocks.getStatus`` occurs
# only in its fetched synthesis, so the source can clear the relevance floor
# only through the bounded content-rescore escalation.
CONTENT_RESCORE_MESSAGE = "Investigate dashboard `apiMocks.getStatus` behavior."

# Scenario 3: shares no vocabulary with any of the five fixtures.
NO_RESULT_MESSAGE = (
    "Investigate why the OLAS staking reward-claim loop occasionally "
    "double-counts checkpoint epochs on Base Sepolia."
)

# Scenario 4 (public corpus unavailable): reuses the dashboard vocabulary so
# the healthy local source proves federated pickup survives a public 503.
UNAVAILABLE_MESSAGE = "Offline corpus investigation for a flaky dashboard test."

MISSING_LAYER_MESSAGE = "Preserve local capture"
INCOMPATIBLE_LAYER_MESSAGE = "Preserve incompatible capture"


def require_env(name: str, *, resolve: bool = True) -> Path:
    value = os.environ.get(name, "").strip()
    assert value, f"{name} is required"
    path = Path(value)
    return path.resolve() if resolve else path.absolute()


WORK = require_env("JINN_STAGE1_WORK")
HERMES_HOME = require_env("HERMES_HOME")
LAYER_BIN = require_env("JINN_STAGE1_LAYER_BIN", resolve=False)
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


# ── Seed fixture loading (rescope R4 seed set → wire shapes) ─────────────────
#
# Mirrors the SAME wire shapes the real seed-import lane produces
# (packages/layer/src/seed-import/{episode-execute,execute}.ts)
# so the real built jinn-layer performs search/get/packet-projection exactly
# as it would against a seeded testnet corpus. No bespoke fixture format.

_NANO_BASE = 1_751_587_200_000_000_000


def _episode_trace(seed: dict[str, Any]) -> dict[str, Any]:
    """`jinn.trace-envelope.v0` for an evidence-episode seed — the same step
    shape `episode-execute.ts`'s `toCapturedTask()` produces: one step per
    authored excerpt (`seed.step.label/title/text`) plus a final
    `seed:synthesis` step (`seed.synthesis`/`seed.attribution`)."""
    content_steps = []
    for i, step in enumerate(seed["steps"]):
        nano = str(_NANO_BASE + i)
        content_steps.append({
            "spanId": f"seed-{i + 1}",
            "parentSpanId": None,
            "name": f"seed:step:{step['label']}",
            "startTimeUnixNano": nano,
            "endTimeUnixNano": nano,
            "attributes": {
                "seed.step.label": step["label"],
                "seed.step.title": step["title"],
                "seed.step.text": step["text"],
            },
            "redactedKeys": [],
        })
    meta_index = len(content_steps)
    nano = str(_NANO_BASE + meta_index)
    attribution: dict[str, Any] = {
        "repo": seed["repo"],
        "origin": seed["attribution"]["origin"],
    }
    if seed.get("baseCommit"):
        attribution["baseCommit"] = seed["baseCommit"]
    if seed["attribution"].get("sourceUrl"):
        attribution["sourceUrl"] = seed["attribution"]["sourceUrl"]
    meta_step = {
        "spanId": f"seed-{meta_index + 1}",
        "parentSpanId": None,
        "name": "seed:synthesis",
        "startTimeUnixNano": nano,
        "endTimeUnixNano": nano,
        "attributes": {
            "seed.synthesis": seed["synthesis"],
            "seed.attribution": attribution,
        },
        "redactedKeys": [],
    }
    tags = ["seed-import"] + [t for t in seed["tags"] if t != "seed-import"]
    return {
        "schemaVersion": "jinn.trace-envelope.v0",
        "session": {"sessionId": f"seed-episode:{seed['id']}", "capturedAt": "2026-07-04T00:00:00.000Z"},
        "task": {"summary": seed["taskSummary"], "distributionTags": tags},
        "environment": {
            "harness": {"name": "jinn-layer-seed-episode-import", "version": "0.1.0"},
            "model": "none",
            "tools": [],
        },
        "steps": content_steps + [meta_step],
        "outcome": {"status": seed["outcome"]["status"], "verifiabilityTier": seed["outcome"]["verifiabilityTier"]},
        "cost": {"durationMs": 0},
        "consent": {"contributionConsent": True, "scrubCompleted": True},
        "provenance": "imported",
    }


def _skill_tags(seed: dict[str, Any]) -> list[str]:
    segments = [s for s in seed["skill"].split("/") if s]
    repo_name = segments[1] if len(segments) > 1 else seed["skill"]
    slug = segments[-1] if segments else seed["skill"]
    tags = ["seed-import"]
    for candidate in (repo_name, slug):
        if candidate not in tags:
            tags.append(candidate)
    return tags


def _skill_trace(seed: dict[str, Any]) -> dict[str, Any]:
    """`jinn.trace-envelope.v0` for a skill seed — the existing skills.sh
    lane's wire shape (`seed-import/execute.ts`'s `toCapturedTask()`):
    `skill.md` + `seed.attribution` on one step. Legacy shape (no first-class
    `jinn.skill.v1` artifact) — proves selection excludes it by relevance,
    same as any other unrelated record (rescope plan §3.3 step 1)."""
    summary = f"Seed import: {seed['skill']}"
    if seed.get("description"):
        summary += f" — {seed['description']}"
    return {
        "schemaVersion": "jinn.trace-envelope.v0",
        "session": {"sessionId": f"seed:{seed['skill']}", "capturedAt": "2026-07-04T00:00:00.000Z"},
        "task": {"summary": summary, "distributionTags": _skill_tags(seed)},
        "environment": {
            "harness": {"name": "jinn-layer-seed-import", "version": "0.1.0"},
            "model": "none",
            "tools": [],
        },
        "steps": [{
            "spanId": "seed-1",
            "parentSpanId": None,
            "name": "seed:skill-md",
            "startTimeUnixNano": str(_NANO_BASE),
            "endTimeUnixNano": str(_NANO_BASE),
            "attributes": {
                "skill.md": seed["skillMd"],
                "seed.attribution": {
                    "skill": seed["skill"],
                    "source": seed["source"],
                    "licence": seed["licence"],
                },
            },
            "redactedKeys": [],
        }],
        "outcome": {"status": "completed", "verifiabilityTier": "user-accepted"},
        "cost": {"durationMs": 0},
        "consent": {"contributionConsent": True, "scrubCompleted": True},
        "provenance": "imported",
    }


class FixtureRecord:
    def __init__(self, ref: str, trace: dict[str, Any]):
        self.ref = ref
        self.trace = trace
        self.trace_bytes = json.dumps(trace, separators=(",", ":"), sort_keys=True).encode()
        self.trace_sha = hashlib.sha256(self.trace_bytes).hexdigest()

    @property
    def task_summary(self) -> str:
        return str(self.trace["task"]["summary"])

    @property
    def tags(self) -> list[str]:
        return list(self.trace["task"]["distributionTags"])

    @property
    def verifiability_tier(self) -> str:
        return str(self.trace["outcome"]["verifiabilityTier"])

    def envelope(self, endpoint: str) -> dict[str, Any]:
        return {
            "schemaVersion": "jinn.execution.v1",
            "solverType": "capture",
            "role": "solution",
            "generatedAt": 1_745_978_400,
            "task": {
                "cid": self.ref,
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
                    "access": {"endpoint": endpoint, "priceUsdc": "0"},
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


def load_seed_records() -> dict[str, FixtureRecord]:
    """The five curated Stage 1 fixtures, keyed by filename stem."""
    episodes = {
        SOURCE_FIXTURE: SOURCE_REF,
        DISTRACTOR_SAME_REPO: DISTRACTOR_SAME_REPO_REF,
        DISTRACTOR_OTHER_DOMAIN: DISTRACTOR_OTHER_DOMAIN_REF,
    }
    skills = {
        DISTRACTOR_SKILL: DISTRACTOR_SKILL_REF,
        DISTRACTOR_SKILL_DUP: DISTRACTOR_SKILL_DUP_REF,
    }
    records: dict[str, FixtureRecord] = {}
    for stem, ref in episodes.items():
        seed = json.loads((SEED_FIXTURES_DIR / f"{stem}.episode.json").read_text(encoding="utf-8"))
        records[stem] = FixtureRecord(ref, _episode_trace(seed))
    for stem, ref in skills.items():
        seed = json.loads((SEED_FIXTURES_DIR / f"{stem}.json").read_text(encoding="utf-8"))
        records[stem] = FixtureRecord(ref, _skill_trace(seed))
    return records


class CorpusFixture:
    def __init__(self) -> None:
        self.unavailable = False
        self.requests: list[tuple[str, str]] = []
        self.endpoint = ""
        self.records = load_seed_records()
        self.by_ref = {record.ref: record for record in self.records.values()}
        self.by_sha = {record.trace_sha: record for record in self.records.values()}

    def search(self, query: str) -> list[dict[str, Any]]:
        needle = query.strip().lower()
        if not needle:
            return []
        hits = []
        for record in self.records.values():
            haystack = f"{record.task_summary} {' '.join(record.tags)}".lower()
            if needle in haystack:
                hits.append({
                    "manifestCid": record.ref,
                    "taskSummary": record.task_summary,
                    "tags": record.tags,
                    "provenance": "imported",
                    "verifiabilityTier": record.verifiability_tier,
                })
        return hits


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
                query = " ".join(parse_qs(parsed.query).get("q", []))
                self.write_json(200, fixture.search(query))
                return
            if parsed.path.startswith("/ipfs/"):
                ref = parsed.path[len("/ipfs/"):]
                record = fixture.by_ref.get(ref)
                if record is None:
                    self.write_json(404, {"error": "not found"})
                    return
                self.write_json(200, record.envelope(fixture.endpoint))
                return
            if parsed.path.startswith("/v1/artifacts/"):
                sha = parsed.path[len("/v1/artifacts/"):].removesuffix("/content")
                record = fixture.by_sha.get(sha)
                if record is None:
                    self.write_json(404, {"error": "not found"})
                    return
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.send_header("content-length", str(len(record.trace_bytes)))
                self.end_headers()
                self.wfile.write(record.trace_bytes)
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

    import jinn_plugin
    from jinn_plugin import jinn_layer

    plugin_dir = Path(jinn_plugin.__file__).resolve().parent
    assert plugin_dir.is_relative_to(Path(sys.prefix).resolve())
    runtime_manifest = json.loads(
        (plugin_dir / "layer-runtime.json").read_text(encoding="utf-8")
    )
    installed_layer_manifest = json.loads(
        (
            plugin_dir
            / "runtime"
            / "node_modules"
            / "@jinn-network"
            / "jinn-layer"
            / "package.json"
        ).read_text(encoding="utf-8")
    )
    expected_layer_version = runtime_manifest["version"]
    resolution = jinn_layer.resolve_binary()
    assert resolution.source == "plugin-local"
    assert resolution.argv == (str(LAYER_BIN),)
    assert runtime_manifest["package"] == "@jinn-network/jinn-layer"
    assert resolution.package == runtime_manifest["package"]
    assert resolution.version == expected_layer_version
    assert installed_layer_manifest["name"] == resolution.package
    assert installed_layer_manifest["version"] == expected_layer_version
    assert LAYER_BIN.is_file() and os.access(LAYER_BIN, os.X_OK)
    contract = json.loads(run(*resolution.argv, "contract", "--json"))
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
    assert "jinn" in calls["commands"]
    assert "jinn-doctor" in calls["cli"]
    assert "corpus" not in calls["commands"]
    assert "corpus_search" not in calls["tools"]
    assert "corpus_fetch" not in calls["tools"]
    return calls


def reset_session_runtime(jinn: Any) -> None:
    jinn.buf.reset()
    jinn.distill.reset()
    jinn._reset_session_state()


def finish_session(
    jinn: Any,
    *,
    session_id: str,
    task_id: str,
    repo: Path,
    message: str,
    expected_pickup: bool,
    mutate: str | None = None,
) -> tuple[str, str | None, str, str]:
    """Drive one complete session lifecycle.

    Returns (session-end stderr, the injected pickup context or None, the
    pickup point-of-use marker text observed on stderr, the mid-session
    `/jinn session` text). The mid-session text is captured HERE, while the
    session's state is live — `_on_session_end` pops it, so a caller
    re-querying `/jinn session` after this returns would read empty state.
    """
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
    marker = pickup_stderr.getvalue()
    if expected_pickup:
        assert pickup is not None, f"expected pickup context, got None (marker={marker!r})"
        assert "[jinn corpus] Prior evidence relevant to this task:" in pickup["context"]
        assert "◇ corpus" in marker and "provided" in marker, marker
    else:
        assert pickup is None, f"expected no pickup, got {pickup!r}"

    current = jinn._handle_jinn("session", session_id=session_id, task_id=task_id)
    if expected_pickup:
        assert "prior note" in current.lower(), current
    assert "contribution parked" not in current.lower(), current
    assert "publication ON" not in current, current

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
            skills_loadout=[],
        )
    return summary.getvalue(), (pickup["context"] if pickup else None), marker, current


def read_store_records() -> list[dict[str, Any]]:
    store = json.loads((MINEABLE_DIR / "mineable-traces.json").read_text(encoding="utf-8"))
    assert store["schemaVersion"] == "jinn.contribution-store.v3"
    assert all("candidate" not in row and "localMetadata" not in row for row in store["records"].values())
    return list(store["records"].values())


def write_local_skill_provenance(session_id: str) -> None:
    """Install a deterministic output of the already-local distillation rail.

    Unrelated to network evidence pickup: local distillation (rung 1) is an
    independent capability (#1486) whose provenance rows still surface in
    history (rescope plan §2 — "keep local distilledSkills provenance").
    """
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


def episode_by_provided_ref(episodes: list[dict[str, Any]], ref: str) -> dict[str, Any] | None:
    for episode in episodes:
        if ref in ((episode.get("activity") or {}).get("providedRefs") or []):
            return episode
    return None


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

    # Smoke-check the real jinn-layer against the real fixture rails before
    # driving any session — search finds the source episode by content, get
    # returns it by ref.
    search_probe = subprocess.run(
        [str(LAYER_BIN), "corpus", "search", "dashboard", "--json", "--limit", "10"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert search_probe.returncode == 0, (
        f"real jinn-layer corpus search failed: stdout={search_probe.stdout!r} "
        f"stderr={search_probe.stderr!r} requests={fixture.requests!r}"
    )
    search_hits = json.loads(search_probe.stdout)
    search_refs = {hit["ref"] for hit in search_hits}
    assert SOURCE_REF in search_refs, (
        f"real jinn-layer corpus search did not return the source fixture: "
        f"stdout={search_probe.stdout!r} stderr={search_probe.stderr!r} "
        f"requests={fixture.requests!r}"
    )
    get_probe = subprocess.run(
        [str(LAYER_BIN), "corpus", "get", SOURCE_REF, "--json"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert get_probe.returncode == 0, (
        f"real jinn-layer corpus get failed: stdout={get_probe.stdout!r} "
        f"stderr={get_probe.stderr!r} requests={fixture.requests!r}"
    )
    assert json.loads(get_probe.stdout)["ref"] == SOURCE_REF

    legacy = HERMES_HOME / "jinn" / "pending" / "legacy-raw-trace.json"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"raw":"LEGACY_RAW_TRACE_SENTINEL"}\n', encoding="utf-8")

    work_repo = make_repo(WORK / "oss-work")
    clean_repo = make_repo(WORK / "oss-clean")
    try:
        # ── Scenario 1/2/5/7: target-task session, evidence provided, most
        # relevant wins, attribution visible, retained Stage 1 sharing state
        # is ignored and the Stage 2 contribution lane stays local ─────────
        reset_session_runtime(jinn)
        jinn.consent.save_state(True, previewed=True)
        requests_before_target = list(fixture.requests)
        parked_summary, target_context, target_marker, target_mid_session = finish_session(
            jinn,
            session_id="stage1-target-task",
            task_id="task-target-task",
            repo=work_repo,
            message=TARGET_TASK_MESSAGE,
            expected_pickup=True,
            mutate="SECRET_ACCEPTED_DIFF_OFF = True",
        )
        assert target_context is not None
        # (1) Content, not metadata: a distinctive excerpt line and source
        # attribution, without advertising a removed manual-fetch surface.
        assert SOURCE_DISTINCTIVE_CONTENT in target_context, target_context
        assert f"source: {SOURCE_REF}" in target_context, target_context
        assert "corpus_fetch" not in target_context, target_context
        # (2) Most relevant wins: distractor and skill refs absent.
        for absent_ref in (
            DISTRACTOR_SAME_REPO_REF,
            DISTRACTOR_OTHER_DOMAIN_REF,
            DISTRACTOR_SKILL_REF,
            DISTRACTOR_SKILL_DUP_REF,
        ):
            assert absent_ref not in target_context, (absent_ref, target_context)
        # Boundary: no skill-install language in the injection, ever.
        assert "skills install" not in target_context.lower()
        assert "adopted automatically" not in target_context.lower()
        # (5) Mid-task /jinn session shows operator-facing pickup summary
        # (refs live in injected context, asserted above — not repeated here).
        assert "used 1 prior note" in target_mid_session.lower(), target_mid_session
        assert "saved this session" in parked_summary.lower()
        assert "contribution recorded" not in parked_summary.lower(), parked_summary
        assert "used 1 prior note" in parked_summary.lower(), parked_summary
        assert list(EPISODES_DIR.glob("*.episode.json")), "canonical episode missing"
        assert not list(CAPTURES_DIR.glob("*.json")), "retired CapturedTask tee wrote a file"
        write_local_skill_provenance("stage1-target-task")
        # (7) Sharing off: only /graphql search traffic (never a publish-
        # shaped POST) happened during this session.
        new_requests = fixture.requests[len(requests_before_target):]
        assert all(method != "POST" or path == "/graphql" for method, path in new_requests), (
            f"a non-search POST happened with sharing off: {new_requests!r}"
        )

        # ── Scenario 2b: content re-score near-miss (#1792). Drive the real
        # stock host hook and fixture-backed corpus bridge, but do not finish
        # this probe session: it is a retrieval acceptance check, not another
        # contribution/capture scenario. Resetting below discards its
        # in-memory session buffer before Scenario 3.
        reset_session_runtime(jinn)
        jinn._on_session_start(
            session_id="stage1-content-rescore",
            cwd=str(work_repo),
            platform="cli",
        )
        content_rescore_pickup = jinn._on_pre_llm_call(
            session_id="stage1-content-rescore",
            task_id="task-content-rescore",
            user_message=CONTENT_RESCORE_MESSAGE,
            is_first_turn=True,
            model="stage1-model",
            platform="cli",
        )
        assert content_rescore_pickup is not None, (
            "metadata score-1 source did not clear the floor after content re-score"
        )
        content_rescore_context = content_rescore_pickup["context"]
        assert SOURCE_DISTINCTIVE_CONTENT in content_rescore_context, content_rescore_context
        assert f"source: {SOURCE_REF}" in content_rescore_context, content_rescore_context
        for absent_ref in (
            DISTRACTOR_SAME_REPO_REF,
            DISTRACTOR_OTHER_DOMAIN_REF,
            DISTRACTOR_SKILL_REF,
            DISTRACTOR_SKILL_DUP_REF,
        ):
            assert absent_ref not in content_rescore_context, (
                absent_ref,
                content_rescore_context,
            )
        reset_session_runtime(jinn)

        # ── Scenario 3: honest no-result. Outbound contribution is parked
        # through Stage 2, so this second eligible session also stays local
        # despite the retained shareConsent=true file above.
        requests_before_no_result = list(fixture.requests)
        no_result_summary, no_result_context, _no_result_marker, no_result_mid_session = finish_session(
            jinn,
            session_id="stage1-no-result",
            task_id="task-no-result",
            repo=work_repo,
            message=NO_RESULT_MESSAGE,
            expected_pickup=False,
            mutate="SECRET_ACCEPTED_DIFF_ON = True",
        )
        assert no_result_context is None
        assert "no relevant prior notes found" in no_result_summary.lower()
        # The honest no-result line comes from THIS session's live state (the
        # search happened, nothing cleared the floor) — not from the empty
        # render an ended/unknown session would also produce.
        assert "no relevant prior notes found" in no_result_mid_session.lower(), (
            no_result_mid_session
        )

        parked_records = read_store_records()
        assert len(parked_records) == 2, parked_records
        assert all(
            "candidate" not in row and "localMetadata" not in row
            for row in parked_records
        ), parked_records
        assert all(
            row["publicationState"] == "disabled"
            for row in parked_records
        ), parked_records
        assert all(
            method != "POST" or path == "/graphql"
            for method, path in fixture.requests[len(requests_before_no_result):]
        ), f"outbound request happened while contribution was parked: {fixture.requests!r}"
        parked_history = jinn._handle_jinn("history")
        assert "preview-required" not in parked_history.lower()
        assert "queued" not in parked_history.lower()
        assert "published" not in parked_history.lower()
        # Local distillation provenance still shows (a retained, independent
        # concept — rescope plan §2), but no shared/network-skill install copy.
        assert "stage1-local-pattern" in parked_history, parked_history
        assert "jinn-installed skill" not in parked_history.lower()
        assert "skills install" not in parked_history.lower()

        # ── Scenario 4: public corpus 503 — healthy local pickup still delivers ──
        fixture.unavailable = True
        unavailable_summary, unavailable_context, _unavailable_marker, _unavailable_mid = finish_session(
            jinn,
            session_id="stage1-corpus-unavailable",
            task_id="task-corpus-unavailable",
            repo=clean_repo,
            message=UNAVAILABLE_MESSAGE,
            expected_pickup=True,
        )
        fixture.unavailable = False
        assert unavailable_context is not None
        assert "source: local-episode:stage1-target-task-" in unavailable_context
        assert SOURCE_REF not in unavailable_context
        assert "used 1 prior note" in unavailable_summary.lower()

        local_layer_bin = Path(jinn.jinn_layer.resolve_binary().argv[0])
        hidden_layer_bin = local_layer_bin.with_name(".jinn-layer-stage1-hidden")
        original_layer_override = os.environ.pop("JINN_LAYER_BIN", None)
        assert not hidden_layer_bin.exists()
        local_layer_bin.rename(hidden_layer_bin)
        try:
            os.environ["JINN_LAYER_BIN"] = str(WORK / "missing-jinn-layer")
            reset_session_runtime(jinn)
            missing_summary, missing_context, _missing_marker, _missing_mid = finish_session(
                jinn,
                session_id="stage1-missing-layer",
                task_id="task-missing-layer",
                repo=clean_repo,
                message=MISSING_LAYER_MESSAGE,
                expected_pickup=False,
            )
            assert missing_context is None
            assert "saved this session locally" in missing_summary.lower()
        finally:
            hidden_layer_bin.rename(local_layer_bin)
            os.environ.pop("JINN_LAYER_BIN", None)
            if original_layer_override is not None:
                os.environ["JINN_LAYER_BIN"] = original_layer_override

        assert jinn.jinn_layer.resolve_binary().source == "plugin-local"

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
        incompatible_summary, incompatible_context, _incompatible_marker, _incompatible_mid = finish_session(
            jinn,
            session_id="stage1-incompatible-layer",
            task_id="task-incompatible-layer",
            repo=clean_repo,
            message=INCOMPATIBLE_LAYER_MESSAGE,
            expected_pickup=False,
        )
        assert incompatible_context is None
        assert "saved this session locally" in incompatible_summary.lower()
        jinn._runner = None

        # ── Boundary: no shared/network-skill install-or-adopt state anywhere
        # (disabled plugin stays stock-silent, asserted up front). Local
        # distillation's own "N installed" count (a different, retained
        # concept — rescope plan §2) is deliberately NOT banned wholesale;
        # the boundary is the removed shared-skill command surface and its
        # copy, not the bare word "installed".
        for rendered in (
            parked_summary, no_result_summary, unavailable_summary,
            missing_summary, incompatible_summary,
            target_mid_session, no_result_mid_session,
        ):
            assert "skills install" not in rendered.lower()
            assert "adopted automatically" not in rendered.lower()
            assert "jinn-installed skill" not in rendered.lower()
        # Shared-skill and outbound command branches are gone outright —
        # every subcommand falls through to the unknown-command help text.
        for removed_args in (
            f"skills install {SOURCE_REF}",
            "skills list",
            "skills uninstall anything",
            "consent",
            "preview",
            "ledger",
        ):
            reply = jinn._handle_jinn(removed_args, session_id="stage1-boundary-check")
            assert reply == jinn._JINN_HELP, (removed_args, reply)
        status_output = jinn._handle_jinn("status")
        assert "contribution: parked — nothing leaves this machine" in status_output
        assert "skills install" not in status_output.lower()
        assert "jinn-installed skill" not in status_output.lower()

        assert legacy.read_text(encoding="utf-8") == '{"raw":"LEGACY_RAW_TRACE_SENTINEL"}\n'
        episodes = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(EPISODES_DIR.glob("*.episode.json"))
        ]
        # (6) Exactly one episode per completed session — five sessions driven.
        assert len(episodes) == 5, [e["session"]["sessionId"] for e in episodes]
        for episode in episodes:
            assert episode["schemaVersion"] == "jinn.episode.v1"
            assert episode["episodeId"]
            assert episode["session"]["capturedAt"].endswith("Z")
            assert episode["trajectory"]
            assert all(str(span["startTimeUnixNano"]).isdigit() for span in episode["trajectory"])

        # (6) The target-task episode records the public delivery, while the
        # public-outage episode records its healthy local fallback. Every
        # other episode's providedRefs remains honestly empty.
        target_episode = episode_by_provided_ref(episodes, SOURCE_REF)
        assert target_episode is not None, [e.get("activity") for e in episodes]
        assert target_episode["activity"]["searchedTerms"], target_episode["activity"]
        assert target_episode["activity"]["providedRefs"] == [SOURCE_REF]
        unavailable_episode = next(
            episode
            for episode in episodes
            if episode["session"]["sessionId"] == "stage1-corpus-unavailable"
        )
        unavailable_refs = unavailable_episode["activity"]["providedRefs"]
        assert len(unavailable_refs) == 1, unavailable_episode["activity"]
        assert unavailable_refs[0].startswith(
            "local-episode:stage1-target-task-"
        ), unavailable_episode["activity"]
        for episode in episodes:
            if episode is target_episode or episode is unavailable_episode:
                continue
            assert episode.get("activity", {}).get("providedRefs") in ([], None), episode["activity"]

        records = read_store_records()
        # (6) Exactly one contribution candidate per eligible session.
        assert len(records) == 2, records
        episode_ids = {episode["episodeId"] for episode in episodes}
        assert {row["recordId"] for row in records}.issubset(episode_ids)
        assert all(
            not episode["contributionCandidate"]["publishMinedTasksConsent"]
            for episode in episodes
            if episode["episodeId"] in {row["recordId"] for row in records}
        )
        assert all(row["publicationState"] == "disabled" for row in records)

        episode_by_id = {episode["episodeId"]: episode for episode in episodes}
        records_by_session = {
            episode_by_id[row["recordId"]]["session"]["sessionId"]: row
            for row in records
        }
        target_row = records_by_session["stage1-target-task"]
        no_result_row = records_by_session["stage1-no-result"]
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
            "targetRecordId": target_row["recordId"],
            "noResultRecordId": no_result_row["recordId"],
            # Explicit session handoff for the daemon-side .mjs leg (PR #1781
            # review): derived from each reference-only store row via
            # recordId → episode → sessionId, never hard-coded, so renaming a
            # driver session cannot silently break the second leg's lookup.
            "targetSessionId": episode_by_id[
                target_row["recordId"]
            ]["session"]["sessionId"],
            "noResultSessionId": episode_by_id[
                no_result_row["recordId"]
            ]["session"]["sessionId"],
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
