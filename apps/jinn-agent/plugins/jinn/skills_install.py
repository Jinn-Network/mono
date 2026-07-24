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
import copy
import hashlib
import json
import logging
import math
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import jinn_layer
from .consent import get_hermes_home

logger = logging.getLogger(__name__)

TRACE_ENVELOPE_ARTIFACT_TYPE = "jinn.trace-envelope.v0"
EPISODE_ARTIFACT_TYPE = "jinn.episode.v1"
SKILL_ARTIFACT_TYPE = "jinn.skill.v1"
MARKER_FILE = ".jinn-ref"

_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_UNIX_NANO_RE = re.compile(r"^[0-9]+$")
_USD_ESTIMATE_RE = re.compile(r"^[0-9]+(\.[0-9]+)?$")
_DELIVERED_CONTENT_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ISO_DATETIME_RE = re.compile(
    r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|"
    r"[02468][048]00|[13579][26]00)-02-29|"
    r"\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|"
    r"(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|"
    r"(?:02)-(?:0[1-9]|1\d|2[0-8])))"
    r"T(?:[01]\d|2[0-3]):[0-5]\d"
    r"(?::[0-5]\d(?:\.\d+)?)?Z$",
    re.ASCII,
)
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


def skills_dir() -> Path:
    return get_hermes_home() / "skills"


def _sanitise_slug(raw: str) -> str:
    """Directory-safe slug: no separators, no traversal, non-empty."""
    slug = _SLUG_RE.sub("-", raw.strip()).strip(".-")
    if not slug:
        raise ValueError(f"cannot derive a usable skill slug from {raw!r}")
    return slug[:80]


# RESIDUAL (flagged cross-repo, 2026-07-08 design): these read-only envelope
# helpers preserve the additive episode-reader compatibility contract. They no
# longer gate any install write (install() defers to the layer). Fully removing
# them remains a separate cleanup from the Hermes retrieval surface.
def _episode_error(path: str, expected: str) -> None:
    raise ValueError(f"jinn.episode.v1 field {path} must be {expected}")


def _episode_object(value: Any, path: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        _episode_error(path, "an object")
    return value


def _episode_string(
    value: Any,
    path: str,
    *,
    max_length: Optional[int] = None,
) -> str:
    if not isinstance(value, str) or not value:
        _episode_error(path, "a nonempty string")
    if (
        max_length is not None
        and len(value.encode("utf-16-le", errors="surrogatepass")) // 2
        > max_length
    ):
        _episode_error(
            path,
            f"a nonempty string of at most {max_length} characters",
        )
    return value


def _episode_enum(value: Any, path: str, choices: Tuple[str, ...]) -> None:
    if value not in choices:
        _episode_error(path, f"one of {', '.join(choices)}")


def _episode_string_list(value: Any, path: str) -> None:
    if not isinstance(value, list):
        _episode_error(path, "an array of nonempty strings")
    for index, item in enumerate(value):
        _episode_string(item, f"{path}[{index}]")


def _episode_boolean(value: Any, path: str) -> None:
    if not isinstance(value, bool):
        _episode_error(path, "a boolean")


def _episode_nonnegative_int(value: Any, path: str) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not float(value).is_integer()
        or abs(value) > _MAX_SAFE_INTEGER
        or value < 0
    ):
        _episode_error(path, "a nonnegative integer")


def _episode_positive_int(value: Any, path: str) -> None:
    _episode_nonnegative_int(value, path)
    if value <= 0:
        _episode_error(path, "a positive integer")


def _episode_iso_datetime(value: Any, path: str) -> None:
    timestamp = _episode_string(value, path)
    if not _ISO_DATETIME_RE.fullmatch(timestamp):
        _episode_error(path, "a canonical ISO datetime")


def _episode_verification_strength(outcome: Dict[str, Any]) -> str:
    canonical = outcome.get("verificationStrength")
    if "verifiabilityTier" in outcome:
        legacy = outcome["verifiabilityTier"]
        if "verificationStrength" in outcome and canonical != legacy:
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


def _without_nulls(
    value: Any,
    optional_keys: Tuple[str, ...],
) -> Any:
    if not isinstance(value, dict):
        return value
    normalized = dict(value)
    for key in optional_keys:
        if normalized.get(key) is None:
            normalized.pop(key, None)
    return normalized


def _normalize_episode_read(parsed: Dict[str, Any]) -> Dict[str, Any]:
    """Return the same additive/defaulted view as TS ``EpisodeV1Schema``."""
    normalized = copy.deepcopy(parsed)
    normalized.setdefault("retrievalVisible", False)
    normalized.setdefault("provenance", "contributed")

    session = _without_nulls(normalized.get("session"), ("parentSessionId",))
    if isinstance(session, dict):
        session.setdefault("kind", "user")
        normalized["session"] = session
    if "origin" not in normalized:
        normalized["origin"] = "legacy-unstamped"

    task = _without_nulls(
        normalized.get("task"),
        ("repositorySlug", "baseCommit", "createdAt", "instanceId"),
    )
    if isinstance(task, dict):
        task.setdefault("distributionTags", [])
        normalized["task"] = task

    trajectory = normalized.get("trajectory")
    if isinstance(trajectory, list):
        normalized_steps: List[Any] = []
        for raw_step in trajectory:
            step = _without_nulls(raw_step, ("truncatedKeys",))
            if isinstance(step, dict):
                step.setdefault("redactedKeys", [])
            normalized_steps.append(step)
        normalized["trajectory"] = normalized_steps

    environment = _without_nulls(
        normalized.get("environment"),
        ("generatorModel", "distributionClass", "verifier"),
    )
    if isinstance(environment, dict):
        generator_model = _without_nulls(
            environment.get("generatorModel"),
            ("provider", "openWeights"),
        )
        if isinstance(generator_model, dict):
            environment["generatorModel"] = generator_model
        verifier = _without_nulls(
            environment.get("verifier"),
            ("evalSemanticsVersion",),
        )
        if isinstance(verifier, dict):
            if verifier.get("type") in ("command", "none"):
                verifier.setdefault("failToPass", [])
                verifier.setdefault("passToPass", [])
            environment["verifier"] = verifier
        normalized["environment"] = environment

    outcome = _without_nulls(
        normalized.get("outcome"),
        ("summary", "acceptedDiff", "testRuns"),
    )
    if isinstance(outcome, dict) and "verifiabilityTier" in outcome:
        legacy = outcome["verifiabilityTier"]
        canonical = outcome.get("verificationStrength")
        outcome["verificationStrength"] = (
            [canonical, legacy]
            if "verificationStrength" in outcome and canonical != legacy
            else legacy
        )
        outcome.pop("verifiabilityTier", None)
    normalized["outcome"] = outcome
    normalized["cost"] = _without_nulls(
        normalized.get("cost"),
        ("tokens", "usdEstimate"),
    )

    for key in ("lineage", "attemptGroup", "activity", "eligibility"):
        if normalized.get(key) is None:
            normalized.pop(key, None)

    lineage = _without_nulls(normalized.get("lineage"), ("mintRef",))
    if isinstance(lineage, dict):
        normalized["lineage"] = lineage

    attempt_group = _without_nulls(
        normalized.get("attemptGroup"),
        ("groupSize", "nPass", "nFail"),
    )
    if isinstance(attempt_group, dict):
        attempt_group.setdefault("relatedAttemptRefs", [])
        normalized["attemptGroup"] = attempt_group

    activity = _without_nulls(
        normalized.get("activity"),
        ("deliveredContentHash",),
    )
    if isinstance(activity, dict):
        missing = object()
        searched_terms = activity.get("searchedTerms", [])
        legacy_provided = activity.get("providedRefs", missing)
        delivered_refs = activity.get(
            "deliveredRefs",
            [] if legacy_provided is missing else legacy_provided,
        )
        eligible_refs = activity.get("eligibleRefs", delivered_refs)
        retrieval_fired = activity.get(
            "retrievalFired",
            (
                isinstance(searched_terms, list)
                and len(searched_terms) > 0
            )
            or (
                isinstance(delivered_refs, list)
                and len(delivered_refs) > 0
            ),
        )
        activity.update({
            "searchedTerms": searched_terms,
            "providedRefs": (
                delivered_refs
                if legacy_provided is missing
                else legacy_provided
            ),
            "surfacedRefs": activity.get("surfacedRefs", []),
            "fetchedRefs": activity.get("fetchedRefs", []),
            "installedSkillRefs": activity.get("installedSkillRefs", []),
            "retrievalFired": retrieval_fired,
            "eligibleRefs": eligible_refs,
            "deliveredRefs": delivered_refs,
            "deliveryMode": activity.get(
                "deliveryMode",
                "delivered" if retrieval_fired is True else "disabled",
            ),
        })
        normalized["activity"] = activity

    return normalized


def _strict_object(
    value: Any,
    path: str,
    allowed: Tuple[str, ...],
    required: Tuple[str, ...] = (),
    nullable: Tuple[str, ...] = (),
) -> Dict[str, Any]:
    obj = _episode_object(value, path)
    unknown = sorted(set(obj) - set(allowed))
    if unknown:
        key = unknown[0]
        field_path = f"{path}.{key}" if path else key
        _episode_error(field_path, "a known strict-write field")
    for key in required:
        if key not in obj:
            field_path = f"{path}.{key}" if path else key
            _episode_error(field_path, "present on canonical writes")
    for key, item in obj.items():
        if item is None and key not in nullable:
            field_path = f"{path}.{key}" if path else key
            _episode_error(field_path, "non-null on canonical writes")
    return obj


def _validate_episode_write(parsed: Dict[str, Any]) -> Dict[str, Any]:
    """Strict Python mirror of ``EpisodeV1WriteSchema``.

    Returns the canonical default-materialized writer view. Reader-only null
    compatibility, additive unknown fields, and legacy origin/session defaults
    are deliberately not accepted here.
    """
    normalized = copy.deepcopy(parsed)
    top = _strict_object(
        normalized,
        "",
        (
            "schemaVersion",
            "episodeId",
            "retrievalVisible",
            "session",
            "origin",
            "task",
            "trajectory",
            "environment",
            "outcome",
            "cost",
            "retention",
            "provenance",
            "lineage",
            "attemptGroup",
            "activity",
            "eligibility",
        ),
        (
            "schemaVersion",
            "episodeId",
            "session",
            "origin",
            "task",
            "trajectory",
            "environment",
            "outcome",
            "cost",
            "retention",
        ),
    )
    top.setdefault("retrievalVisible", False)
    top.setdefault("provenance", "contributed")

    _strict_object(
        top["session"],
        "session",
        ("sessionId", "capturedAt", "kind", "parentSessionId"),
        ("sessionId", "capturedAt", "kind"),
    )
    _strict_object(
        top["origin"],
        "origin",
        ("writer", "build"),
        ("writer", "build"),
    )
    task = _strict_object(
        top["task"],
        "task",
        (
            "summary",
            "distributionTags",
            "repositorySlug",
            "baseCommit",
            "createdAt",
            "instanceId",
        ),
        ("summary",),
    )
    task.setdefault("distributionTags", [])

    trajectory = top["trajectory"]
    if isinstance(trajectory, list):
        for index, raw_step in enumerate(trajectory):
            step = _strict_object(
                raw_step,
                f"trajectory[{index}]",
                (
                    "spanId",
                    "parentSpanId",
                    "kind",
                    "name",
                    "startTimeUnixNano",
                    "endTimeUnixNano",
                    "attributes",
                    "redactedKeys",
                    "truncatedKeys",
                ),
                (
                    "spanId",
                    "parentSpanId",
                    "kind",
                    "name",
                    "startTimeUnixNano",
                    "endTimeUnixNano",
                    "attributes",
                ),
                ("parentSpanId",),
            )
            step.setdefault("redactedKeys", [])

    environment = _strict_object(
        top["environment"],
        "environment",
        (
            "harness",
            "model",
            "tools",
            "skillsLoadout",
            "generatorModel",
            "distributionClass",
            "verifier",
        ),
        ("harness", "model", "tools", "skillsLoadout"),
    )
    _strict_object(
        environment["harness"],
        "environment.harness",
        ("name", "version"),
        ("name", "version"),
    )
    if "generatorModel" in environment:
        _strict_object(
            environment["generatorModel"],
            "environment.generatorModel",
            ("id", "provider", "openWeights", "source"),
            ("id", "source"),
        )
    if "verifier" in environment:
        verifier = _strict_object(
            environment["verifier"],
            "environment.verifier",
            ("type", "failToPass", "passToPass", "evalSemanticsVersion"),
            ("type",),
        )
        if verifier.get("type") == "f2p-p2p":
            for key in ("failToPass", "passToPass", "evalSemanticsVersion"):
                if key not in verifier:
                    _episode_error(
                        f"environment.verifier.{key}",
                        "present for f2p-p2p canonical writes",
                    )
        elif verifier.get("type") in ("command", "none"):
            verifier.setdefault("failToPass", [])
            verifier.setdefault("passToPass", [])

    outcome = _strict_object(
        top["outcome"],
        "outcome",
        (
            "status",
            "verificationStrength",
            "verifiabilityTier",
            "summary",
            "acceptedDiff",
            "testRuns",
        ),
        ("status",),
    )
    if "verifiabilityTier" in outcome:
        legacy = outcome["verifiabilityTier"]
        canonical = outcome.get("verificationStrength")
        if "verificationStrength" in outcome and canonical != legacy:
            _episode_error(
                "outcome.verificationStrength",
                "equal to outcome.verifiabilityTier when both are present",
            )
        outcome["verificationStrength"] = legacy
        outcome.pop("verifiabilityTier", None)
    if "verificationStrength" not in outcome:
        _episode_error(
            "outcome.verificationStrength",
            "present on canonical writes",
        )
    if "testRuns" in outcome:
        _strict_object(
            outcome["testRuns"],
            "outcome.testRuns",
            ("passed", "failed"),
            ("passed", "failed"),
        )

    cost = _strict_object(
        top["cost"],
        "cost",
        ("durationMs", "tokens", "usdEstimate"),
        ("durationMs",),
    )
    if "tokens" in cost:
        _strict_object(
            cost["tokens"],
            "cost.tokens",
            ("input", "output"),
            ("input", "output"),
        )
    _strict_object(
        top["retention"],
        "retention",
        ("policy",),
        ("policy",),
    )

    if "lineage" in top:
        _strict_object(
            top["lineage"],
            "lineage",
            ("episodeId", "mintRef"),
            ("episodeId",),
        )
    if "attemptGroup" in top:
        attempt_group = _strict_object(
            top["attemptGroup"],
            "attemptGroup",
            (
                "groupId",
                "attemptId",
                "relatedAttemptRefs",
                "groupSize",
                "nPass",
                "nFail",
            ),
            ("groupId", "attemptId"),
        )
        attempt_group.setdefault("relatedAttemptRefs", [])
    if "activity" in top:
        activity = _strict_object(
            top["activity"],
            "activity",
            (
                "searchedTerms",
                "providedRefs",
                "surfacedRefs",
                "fetchedRefs",
                "installedSkillRefs",
                "retrievalFired",
                "eligibleRefs",
                "deliveredRefs",
                "deliveryMode",
                "deliveredContentHash",
            ),
            (
                "retrievalFired",
                "eligibleRefs",
                "deliveredRefs",
                "deliveryMode",
            ),
        )
        for key in (
            "searchedTerms",
            "providedRefs",
            "surfacedRefs",
            "fetchedRefs",
            "installedSkillRefs",
        ):
            activity.setdefault(key, [])
        if (
            activity.get("deliveryMode") == "delivered"
            or (
                isinstance(activity.get("deliveredRefs"), list)
                and len(activity["deliveredRefs"]) > 0
            )
        ) and "deliveredContentHash" not in activity:
            _episode_error(
                "activity.deliveredContentHash",
                "present when delivered evidence exists",
            )
    if "eligibility" in top:
        _strict_object(
            top["eligibility"],
            "eligibility",
            ("eligible", "reason", "checkedAt"),
            ("eligible", "reason", "checkedAt"),
        )

    _validate_episode(normalized)
    return normalized


def _validate_episode(parsed: Dict[str, Any]) -> None:
    """Mirror EpisodeV1Schema's additive, dependency-light read contract."""
    _episode_enum(
        parsed.get("schemaVersion"),
        "schemaVersion",
        (EPISODE_ARTIFACT_TYPE,),
    )
    _episode_string(parsed.get("episodeId"), "episodeId")
    if "retrievalVisible" in parsed:
        _episode_boolean(parsed["retrievalVisible"], "retrievalVisible")

    session = _episode_object(parsed.get("session"), "session")
    _episode_string(
        session.get("sessionId"),
        "session.sessionId",
        max_length=128,
    )
    _episode_iso_datetime(session.get("capturedAt"), "session.capturedAt")
    _episode_enum(
        session.get("kind", "user"),
        "session.kind",
        ("user", "host-internal"),
    )
    if session.get("parentSessionId") is not None:
        _episode_string(
            session["parentSessionId"],
            "session.parentSessionId",
            max_length=128,
        )

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
    if environment.get("generatorModel") is not None:
        generator_model = _episode_object(
            environment["generatorModel"],
            "environment.generatorModel",
        )
        _episode_string(
            generator_model.get("id"),
            "environment.generatorModel.id",
        )
        if generator_model.get("provider") is not None:
            _episode_string(
                generator_model["provider"],
                "environment.generatorModel.provider",
            )
        if generator_model.get("openWeights") is not None:
            _episode_boolean(
                generator_model["openWeights"],
                "environment.generatorModel.openWeights",
            )
        _episode_enum(
            generator_model.get("source"),
            "environment.generatorModel.source",
            ("stream", "config"),
        )
    if environment.get("distributionClass") is not None:
        _episode_enum(
            environment["distributionClass"],
            "environment.distributionClass",
            ("open", "restricted-tos", "unknown"),
        )
    if environment.get("verifier") is not None:
        verifier = _episode_object(
            environment["verifier"],
            "environment.verifier",
        )
        verifier_type = verifier.get("type")
        _episode_enum(
            verifier_type,
            "environment.verifier.type",
            ("f2p-p2p", "command", "none"),
        )
        if verifier_type == "f2p-p2p":
            _episode_string_list(
                verifier.get("failToPass"),
                "environment.verifier.failToPass",
            )
            _episode_string_list(
                verifier.get("passToPass"),
                "environment.verifier.passToPass",
            )
            _episode_string(
                verifier.get("evalSemanticsVersion"),
                "environment.verifier.evalSemanticsVersion",
            )
        else:
            _episode_string_list(
                verifier.get("failToPass", []),
                "environment.verifier.failToPass",
            )
            _episode_string_list(
                verifier.get("passToPass", []),
                "environment.verifier.passToPass",
            )
            if verifier.get("evalSemanticsVersion") is not None:
                _episode_string(
                    verifier["evalSemanticsVersion"],
                    "environment.verifier.evalSemanticsVersion",
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
    if outcome.get("acceptedDiff") is not None:
        _episode_boolean(outcome["acceptedDiff"], "outcome.acceptedDiff")
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

    if parsed.get("lineage") is not None:
        lineage = _episode_object(parsed["lineage"], "lineage")
        _episode_string(lineage.get("episodeId"), "lineage.episodeId")
        if lineage.get("mintRef") is not None:
            _episode_string(lineage["mintRef"], "lineage.mintRef")

    if parsed.get("attemptGroup") is not None:
        attempt_group = _episode_object(
            parsed["attemptGroup"],
            "attemptGroup",
        )
        _episode_string(
            attempt_group.get("groupId"),
            "attemptGroup.groupId",
        )
        _episode_string(
            attempt_group.get("attemptId"),
            "attemptGroup.attemptId",
        )
        _episode_string_list(
            attempt_group.get("relatedAttemptRefs", []),
            "attemptGroup.relatedAttemptRefs",
        )
        if attempt_group.get("groupSize") is not None:
            _episode_positive_int(
                attempt_group["groupSize"],
                "attemptGroup.groupSize",
            )
        for key in ("nPass", "nFail"):
            if attempt_group.get(key) is not None:
                _episode_nonnegative_int(
                    attempt_group[key],
                    f"attemptGroup.{key}",
                )
        if all(
            attempt_group.get(key) is not None
            for key in ("groupSize", "nPass", "nFail")
        ) and (
            attempt_group["groupSize"]
            != attempt_group["nPass"] + attempt_group["nFail"]
        ):
            _episode_error(
                "attemptGroup.groupSize",
                "equal to attemptGroup.nPass + attemptGroup.nFail "
                "when all counts are present",
            )

    if parsed.get("activity") is not None:
        activity = _episode_object(parsed["activity"], "activity")
        searched_terms = activity.get("searchedTerms", [])
        missing = object()
        legacy_provided = activity.get("providedRefs", missing)
        delivered_refs = activity.get(
            "deliveredRefs",
            [] if legacy_provided is missing else legacy_provided,
        )
        eligible_refs = activity.get("eligibleRefs", delivered_refs)
        retrieval_fired = activity.get(
            "retrievalFired",
            (
                isinstance(searched_terms, list)
                and len(searched_terms) > 0
            )
            or (
                isinstance(delivered_refs, list)
                and len(delivered_refs) > 0
            ),
        )
        provided_refs = (
            delivered_refs
            if legacy_provided is missing
            else legacy_provided
        )
        delivery_mode = activity.get(
            "deliveryMode",
            "delivered" if retrieval_fired is True else "disabled",
        )

        _episode_string_list(searched_terms, "activity.searchedTerms")
        _episode_string_list(provided_refs, "activity.providedRefs")
        _episode_string_list(
            activity.get("surfacedRefs", []),
            "activity.surfacedRefs",
        )
        _episode_string_list(
            activity.get("fetchedRefs", []),
            "activity.fetchedRefs",
        )
        _episode_string_list(
            activity.get("installedSkillRefs", []),
            "activity.installedSkillRefs",
        )
        _episode_boolean(retrieval_fired, "activity.retrievalFired")
        _episode_string_list(eligible_refs, "activity.eligibleRefs")
        _episode_string_list(delivered_refs, "activity.deliveredRefs")
        _episode_enum(
            delivery_mode,
            "activity.deliveryMode",
            ("delivered", "disabled", "degraded", "withheld"),
        )
        if activity.get("deliveredContentHash") is not None:
            delivered_hash = _episode_string(
                activity["deliveredContentHash"],
                "activity.deliveredContentHash",
            )
            if not _DELIVERED_CONTENT_HASH_RE.fullmatch(delivered_hash):
                _episode_error(
                    "activity.deliveredContentHash",
                    "a lowercase sha256 content hash",
                )

    if parsed.get("eligibility") is not None:
        eligibility = _episode_object(parsed["eligibility"], "eligibility")
        _episode_boolean(
            eligibility.get("eligible"),
            "eligibility.eligible",
        )
        _episode_string(eligibility.get("reason"), "eligibility.reason")
        _episode_iso_datetime(
            eligibility.get("checkedAt"),
            "eligibility.checkedAt",
        )


def _extract_skill(record: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
    """Return (skill_view, verified sha256) for a first-class jinn.skill.v1 artifact.

    Retained reader compatibility only. The install trust path remains
    ``jinn-layer skills install``. A present-but-corrupt skill artifact is an
    error (no fall-through to evidence envelopes).
    """
    artifacts = record.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("corpus record has no artifacts")
    artifact = next(
        (
            candidate
            for candidate in artifacts
            if isinstance(candidate, dict)
            and candidate.get("artifactType") == SKILL_ARTIFACT_TYPE
        ),
        None,
    )
    if artifact is None:
        raise ValueError("no jinn.skill.v1 artifact in this record")

    content_b64 = artifact.get("contentBase64")
    expected = str(artifact.get("sha256") or "")
    if not isinstance(content_b64, str) or not expected:
        raise ValueError("jinn.skill.v1 artifact is missing content or sha256")
    content = base64.b64decode(content_b64)
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected:
        raise ValueError(
            f"sha256 mismatch — refusing to read (expected {expected[:12]}…, got {actual[:12]}…)"
        )
    parsed = json.loads(content.decode("utf-8"))
    if not isinstance(parsed, dict) or parsed.get("schemaVersion") != SKILL_ARTIFACT_TYPE:
        raise ValueError("jinn.skill.v1 artifact body has a mismatched schemaVersion")
    skill = parsed.get("skill")
    if not isinstance(skill, dict):
        raise ValueError("jinn.skill.v1 artifact is missing skill object")
    skill_md = skill.get("skillMd")
    if not isinstance(skill_md, str) or not skill_md.strip():
        raise ValueError("jinn.skill.v1 artifact has empty skillMd")
    name = skill.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("jinn.skill.v1 artifact has empty skill name")
    provenance = parsed.get("provenance")
    if not isinstance(provenance, dict):
        provenance = {}
    return {
        "skillMd": skill_md,
        "name": name,
        "provenance": provenance,
        "shape": "jinn.skill.v1",
    }, expected


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

    normalized = _normalize_episode_read(parsed)
    _validate_episode(normalized)
    trajectory = normalized.get("trajectory")
    outcome = normalized.get("outcome")
    projected_outcome = dict(outcome) if isinstance(outcome, dict) else {}
    projected_outcome["verifiabilityTier"] = _episode_verification_strength(
        projected_outcome
    )
    return {
        **normalized,
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
