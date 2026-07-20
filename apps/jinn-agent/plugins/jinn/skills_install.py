"""/jinn skills — install corpus-published skills into Hermes's native skills.

Closes the seed-consumption loop (mono #1345): a skill published to the
corpus as a trace envelope becomes a locally installed Hermes skill —
``jinn-layer corpus get <ref>`` → sha256 verification → extract the
envelope's ``skill.md`` step attribute → write
``$HERMES_HOME/skills/<slug>/SKILL.md`` — and Hermes's native loader takes
over from there.

Consuming is ALWAYS allowed: no consent state is consulted anywhere in this
module. Consent gates contributing (capture/publish), never reading.

Every install writes a ``.jinn-ref`` marker (the corpus ref) next to the
SKILL.md; ``uninstall`` refuses to touch a skill directory without the
marker, so a user's own skills can never be deleted through this surface.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import jinn_layer
from .consent import get_hermes_home

logger = logging.getLogger(__name__)

TRACE_ENVELOPE_ARTIFACT_TYPE = "jinn.trace-envelope.v0"
EPISODE_ARTIFACT_TYPE = "jinn.episode.v1"
MARKER_FILE = ".jinn-ref"

_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_UNIX_NANO_RE = re.compile(r"^\d+$")
_USD_ESTIMATE_RE = re.compile(r"^\d+(\.\d+)?$")


def skills_dir() -> Path:
    return get_hermes_home() / "skills"


def _sanitise_slug(raw: str) -> str:
    """Directory-safe slug: no separators, no traversal, non-empty."""
    slug = _SLUG_RE.sub("-", raw.strip()).strip(".-")
    if not slug:
        raise ValueError(f"cannot derive a usable skill slug from {raw!r}")
    return slug[:80]


# RESIDUAL (flagged cross-repo, 2026-07-08 design): these read-only envelope
# helpers still serve corpus_fetch + pickup classification for DISPLAY. They no
# longer gate any install write (install() defers to the layer). Fully removing
# them needs an interpreted `jinn-layer corpus get` projection — a harness-layer
# follow-up, tracked separately.
def _episode_error(path: str, expected: str) -> None:
    raise ValueError(f"jinn.episode.v1 field {path} must be {expected}")


def _episode_object(value: Any, path: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        _episode_error(path, "an object")
    return value


def _episode_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        _episode_error(path, "a nonempty string")
    return value


def _episode_enum(value: Any, path: str, choices: Tuple[str, ...]) -> None:
    if value not in choices:
        _episode_error(path, f"one of {', '.join(choices)}")


def _episode_string_list(value: Any, path: str) -> None:
    if not isinstance(value, list):
        _episode_error(path, "an array of nonempty strings")
    for index, item in enumerate(value):
        _episode_string(item, f"{path}[{index}]")


def _episode_nonnegative_int(value: Any, path: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _episode_error(path, "a nonnegative integer")


def _episode_verification_strength(outcome: Dict[str, Any]) -> str:
    canonical = outcome.get("verificationStrength")
    if "verifiabilityTier" in outcome:
        legacy = outcome["verifiabilityTier"]
        if canonical is not None and canonical != legacy:
            _episode_error(
                "outcome.verificationStrength",
                "equal to outcome.verifiabilityTier when both are present",
            )
        canonical = legacy
    _episode_enum(
        canonical,
        "outcome.verificationStrength",
        ("user-accepted", "tests-passed", "evaluator-verified"),
    )
    return str(canonical)


def _validate_episode(parsed: Dict[str, Any]) -> None:
    """Validate the dependency-light canonical shape this read path projects."""
    _episode_string(parsed.get("episodeId"), "episodeId")
    if "retrievalVisible" in parsed and not isinstance(
        parsed["retrievalVisible"], bool
    ):
        _episode_error("retrievalVisible", "a boolean")

    session = _episode_object(parsed.get("session"), "session")
    _episode_string(session.get("sessionId"), "session.sessionId")
    _episode_string(session.get("capturedAt"), "session.capturedAt")
    _episode_enum(
        session.get("kind", "user"),
        "session.kind",
        ("user", "host-internal"),
    )
    if session.get("parentSessionId") is not None:
        _episode_string(session["parentSessionId"], "session.parentSessionId")

    origin = parsed.get("origin", "legacy-unstamped")
    if origin != "legacy-unstamped":
        origin_obj = _episode_object(origin, "origin")
        _episode_string(origin_obj.get("writer"), "origin.writer")
        _episode_string(origin_obj.get("build"), "origin.build")

    task = _episode_object(parsed.get("task"), "task")
    _episode_string(task.get("summary"), "task.summary")
    _episode_string_list(
        task.get("distributionTags", []), "task.distributionTags"
    )
    for key in ("repositorySlug", "baseCommit", "instanceId"):
        if task.get(key) is not None:
            _episode_string(task[key], f"task.{key}")
    if task.get("createdAt") is not None:
        _episode_nonnegative_int(task["createdAt"], "task.createdAt")

    trajectory = parsed.get("trajectory")
    if not isinstance(trajectory, list) or not trajectory:
        _episode_error("trajectory", "a nonempty array")
    for index, raw_step in enumerate(trajectory):
        path = f"trajectory[{index}]"
        step = _episode_object(raw_step, path)
        _episode_string(step.get("spanId"), f"{path}.spanId")
        if "parentSpanId" not in step:
            _episode_error(f"{path}.parentSpanId", "a nonempty string or null")
        parent_span_id = step.get("parentSpanId")
        if parent_span_id is not None:
            _episode_string(parent_span_id, f"{path}.parentSpanId")
        _episode_enum(
            step.get("kind"),
            f"{path}.kind",
            ("jinn.agent_turn", "jinn.tool_call"),
        )
        _episode_string(step.get("name"), f"{path}.name")
        for key in ("startTimeUnixNano", "endTimeUnixNano"):
            timing = _episode_string(step.get(key), f"{path}.{key}")
            if not _UNIX_NANO_RE.fullmatch(timing):
                _episode_error(f"{path}.{key}", "a unix-nanosecond digit string")
        _episode_object(step.get("attributes"), f"{path}.attributes")
        _episode_string_list(
            step.get("redactedKeys", []), f"{path}.redactedKeys"
        )
        if step.get("truncatedKeys") is not None:
            _episode_string_list(step["truncatedKeys"], f"{path}.truncatedKeys")

    environment = _episode_object(parsed.get("environment"), "environment")
    harness = _episode_object(environment.get("harness"), "environment.harness")
    _episode_string(harness.get("name"), "environment.harness.name")
    _episode_string(harness.get("version"), "environment.harness.version")
    _episode_string(environment.get("model"), "environment.model")
    _episode_string_list(environment.get("tools"), "environment.tools")
    _episode_string_list(
        environment.get("skillsLoadout"), "environment.skillsLoadout"
    )

    outcome = _episode_object(parsed.get("outcome"), "outcome")
    _episode_enum(
        outcome.get("status"),
        "outcome.status",
        ("completed", "failed", "abandoned"),
    )
    _episode_verification_strength(outcome)
    if outcome.get("summary") is not None:
        _episode_string(outcome["summary"], "outcome.summary")
    if outcome.get("acceptedDiff") is not None and not isinstance(
        outcome["acceptedDiff"], bool
    ):
        _episode_error("outcome.acceptedDiff", "a boolean")
    if outcome.get("testRuns") is not None:
        test_runs = _episode_object(outcome["testRuns"], "outcome.testRuns")
        _episode_nonnegative_int(test_runs.get("passed"), "outcome.testRuns.passed")
        _episode_nonnegative_int(test_runs.get("failed"), "outcome.testRuns.failed")

    cost = _episode_object(parsed.get("cost"), "cost")
    _episode_nonnegative_int(cost.get("durationMs"), "cost.durationMs")
    if cost.get("tokens") is not None:
        tokens = _episode_object(cost["tokens"], "cost.tokens")
        _episode_nonnegative_int(tokens.get("input"), "cost.tokens.input")
        _episode_nonnegative_int(tokens.get("output"), "cost.tokens.output")
    if cost.get("usdEstimate") is not None:
        estimate = _episode_string(cost["usdEstimate"], "cost.usdEstimate")
        if not _USD_ESTIMATE_RE.fullmatch(estimate):
            _episode_error("cost.usdEstimate", "a nonnegative decimal string")

    retention = _episode_object(parsed.get("retention"), "retention")
    _episode_enum(
        retention.get("policy"),
        "retention.policy",
        ("local-private", "contribution-eligible"),
    )
    _episode_enum(
        parsed.get("provenance", "contributed"),
        "provenance",
        ("contributed", "imported"),
    )


def _extract_trace(record: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
    """Return (legacy-compatible evidence projection, verified sha256).

    Canonical Episode is preferred when both carriers are present. The selected
    artifact's bytes are verified BEFORE parsing and a malformed preferred
    carrier never falls back to legacy trace content.
    """
    artifacts = record.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("corpus record has no artifacts")
    artifact = next(
        (
            candidate
            for artifact_type in (
                EPISODE_ARTIFACT_TYPE,
                TRACE_ENVELOPE_ARTIFACT_TYPE,
            )
            for candidate in artifacts
            if isinstance(candidate, dict)
            and candidate.get("artifactType") == artifact_type
        ),
        None,
    )
    if artifact is None:
        raise ValueError(
            "no jinn.episode.v1 or jinn.trace-envelope.v0 artifact in this record"
        )

    artifact_type = str(artifact["artifactType"])
    content_b64 = artifact.get("contentBase64")
    expected = str(artifact.get("sha256") or "")
    if not isinstance(content_b64, str) or not expected:
        raise ValueError(f"{artifact_type} artifact is missing content or sha256")
    content = base64.b64decode(content_b64)
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected:
        raise ValueError(
            f"sha256 mismatch — refusing to read (expected {expected[:12]}…, got {actual[:12]}…)"
        )
    parsed = json.loads(content.decode("utf-8"))
    if not isinstance(parsed, dict) or parsed.get("schemaVersion") != artifact_type:
        raise ValueError(
            f"{artifact_type} artifact body has a mismatched schemaVersion"
        )
    if artifact_type == TRACE_ENVELOPE_ARTIFACT_TYPE:
        return parsed, expected

    _validate_episode(parsed)
    trajectory = parsed.get("trajectory")
    outcome = parsed.get("outcome")
    projected_outcome = dict(outcome) if isinstance(outcome, dict) else {}
    projected_outcome["verifiabilityTier"] = _episode_verification_strength(
        projected_outcome
    )
    return {
        **parsed,
        "steps": trajectory,
        "outcome": projected_outcome,
    }, expected


def _skill_md_and_slug(trace: Dict[str, Any], ref: str) -> Tuple[str, str]:
    steps = trace.get("steps")
    if not isinstance(steps, list):
        raise ValueError("trace envelope has no steps")
    for step in steps:
        if not isinstance(step, dict):
            continue
        attrs = step.get("attributes")
        if not isinstance(attrs, dict):
            continue
        skill_md = attrs.get("skill.md")
        if not isinstance(skill_md, str) or not skill_md.strip():
            continue
        attribution = attrs.get("seed.attribution")
        raw_slug: Optional[str] = None
        if isinstance(attribution, dict) and isinstance(attribution.get("skill"), str):
            raw_slug = str(attribution["skill"]).split("/")[-1]
        if raw_slug is None:
            tags = (trace.get("task") or {}).get("distributionTags")
            if isinstance(tags, list):
                candidates = [t for t in tags if isinstance(t, str) and t not in ("seed-import",)]
                raw_slug = candidates[-1] if candidates else None
        return skill_md, _sanitise_slug(raw_slug or ref)
    raise ValueError("no skill.md content in this envelope — not an installable skill record")


def install(ref: str, runner: Optional[jinn_layer.Runner] = None) -> str:
    """Install a corpus-published skill by ref via `jinn-layer skills install`.

    The layer extracts, sha256-verifies, and writes SKILL.md (+ companions) into
    the skills dir; this function only chooses the dir and drops the .jinn-ref
    fence. No envelope parsing or hash verification happens here — that is the
    layer's job (thin-fork boundary, mono #1345 / distillation-v1 §9).
    """
    skills_root = skills_dir()
    skills_root.mkdir(parents=True, exist_ok=True)
    code, out, err = jinn_layer.run(
        ["skills", "install", ref, "--json"], runner, cwd=str(skills_root)
    )
    if code != 0:
        raise ValueError(f"skills install failed: {err or out}")
    try:
        result = json.loads(out)
        target = Path(result["dir"])
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError(f"unreadable skills install result: {exc}")
    (target / MARKER_FILE).write_text(
        json.dumps({"ref": ref}) + "\n", encoding="utf-8"
    )
    logger.info("jinn: installed skill %s from %s", target.name, ref)
    return str(target / "SKILL.md")


def list_installed() -> List[Dict[str, str]]:
    """Jinn-installed skills only (those carrying the .jinn-ref marker)."""
    directory = skills_dir()
    if not directory.exists():
        return []
    out: List[Dict[str, str]] = []
    for child in sorted(directory.iterdir()):
        marker = child / MARKER_FILE
        if not (child.is_dir() and marker.exists() and (child / "SKILL.md").exists()):
            continue
        try:
            ref = str(json.loads(marker.read_text(encoding="utf-8")).get("ref", ""))
        except Exception:
            ref = ""
        out.append({"slug": child.name, "ref": ref})
    return out


def uninstall(slug: str) -> str:
    """Remove a jinn-installed skill. Refuses anything without the marker."""
    target = skills_dir() / _sanitise_slug(slug)
    if not target.is_dir():
        raise ValueError(f"no installed skill named {slug!r}")
    if not (target / MARKER_FILE).exists():
        raise ValueError(
            f"{slug!r} was not installed by jinn (no {MARKER_FILE} marker) — refusing to remove it"
        )
    shutil.rmtree(target)
    logger.info("jinn: uninstalled skill %s", slug)
    return str(target)
