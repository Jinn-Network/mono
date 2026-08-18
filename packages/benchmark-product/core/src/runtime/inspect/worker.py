#!/usr/bin/env python3
"""Pinned Inspect 0.3.255 worker. Arbitrary task code runs only in this child process."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import os
from contextlib import redirect_stdout
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Any
from urllib.parse import unquote, urlparse

# The selected project is an input, not worker state. Enforce this again in-process because task
# loading can traverse Inspect-managed import paths before any adapter callback runs.
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["HF_DATASETS_CACHE"] = "/tmp/jinn-hf-datasets"
sys.dont_write_bytecode = True

import inspect_ai
from inspect_ai import eval as inspect_eval
from inspect_ai.log import read_eval_log


SUPPORTED_INSPECT_VERSION = "0.3.255"
SUPPORTED_INSPECT_WHEEL_SHA256 = "958e773a8d0cc8873314e3f96d1143cbb4e0b9e4bacc2cbec6b4d5576ceecf2c"
IGNORED_PROJECT_PARTS = {".git", ".inspect_ai", ".mypy_cache", ".pytest_cache", ".venv", "__pycache__"}


def prepare_readonly_hf_dataset_cache() -> None:
    """Keep prefetched bytes read-only while giving datasets a scratch lock/index root."""
    source = Path(os.environ.get("HF_HOME", "")) / "datasets"
    target = Path(os.environ["HF_DATASETS_CACHE"])
    target.mkdir(parents=True, exist_ok=True)
    if not source.is_dir():
        return
    for entry in source.iterdir():
        if entry.name.endswith(".lock"):
            continue
        link = target / entry.name
        if not link.exists() and not link.is_symlink():
            link.symlink_to(entry)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_records(records: list[tuple[str, str]]) -> str:
    encoded = json.dumps(sorted(records), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def project_tree_sha256(project_dir: Path) -> str:
    records: list[tuple[str, str]] = []
    for path in sorted(project_dir.rglob("*")):
        relative = path.relative_to(project_dir)
        if any(part in IGNORED_PROJECT_PARTS for part in relative.parts) or path.suffix == ".pyc":
            continue
        if path.is_symlink() and not path.resolve().is_file():
            raise ValueError(f"project tree contains an unsupported directory or broken symlink: {relative.as_posix()}")
        if path.is_file():
            records.append((relative.as_posix(), sha256_file(path.resolve())))
    return sha256_records(records)


def distribution_content_sha256(distribution: importlib.metadata.Distribution) -> str:
    records: list[tuple[str, str]] = []
    for entry in distribution.files or []:
        path = Path(distribution.locate_file(entry))
        if path.is_file() and path.suffix != ".pyc":
            records.append((str(entry), sha256_file(path.resolve())))
    if not records:
        raise ValueError(f"cannot fingerprint installed distribution {distribution.metadata['Name']!r}")
    return sha256_records(records)


def python_environment_sha256() -> str:
    records: list[tuple[str, str]] = []
    for distribution in importlib.metadata.distributions():
        name = str(distribution.metadata.get("Name") or "").lower()
        version = str(distribution.version)
        # RECORD is useful metadata but does not prove that installed files still match it.
        # Hash the bytes that can actually import and execute so in-place dependency drift is
        # rejected even when package metadata and versions remain unchanged.
        records.append((f"{name}=={version}", distribution_content_sha256(distribution)))
    return sha256_records(records)


def local_path(location: str) -> Path:
    parsed = urlparse(location)
    if parsed.scheme in ("", "file"):
        return Path(unquote(parsed.path if parsed.scheme else location)).resolve()
    raise ValueError(f"native log location uses unsupported non-local scheme {parsed.scheme!r}")


def require_runtime() -> dict[str, str]:
    if inspect_ai.__version__ != SUPPORTED_INSPECT_VERSION:
        raise ValueError(
            f"Inspect drift: required {SUPPORTED_INSPECT_VERSION}, found {inspect_ai.__version__}"
        )
    if sys.version_info < (3, 11):
        raise ValueError(f"Python 3.11+ is required, found {sys.version.split()[0]}")
    inspect_distribution = importlib.metadata.distribution("inspect-ai")
    runtime = {
        "inspectVersion": inspect_ai.__version__,
        "inspectWheelSha256": SUPPORTED_INSPECT_WHEEL_SHA256,
        "pythonVersion": sys.version.split()[0],
        "pythonExecutableSha256": sha256_file(Path(sys.executable).resolve()),
        "pythonEnvironmentSha256": python_environment_sha256(),
        "inspectDistributionSha256": distribution_content_sha256(inspect_distribution),
    }
    for distribution_name, field_name in (
        ("inspect-evals", "inspectEvalsVersion"),
        ("openai", "openaiSdkVersion"),
    ):
        try:
            runtime[field_name] = importlib.metadata.version(distribution_name)
        except importlib.metadata.PackageNotFoundError:
            pass
    return runtime


def selected_samples_sha256(samples: list[Any]) -> str:
    material = []
    for sample in samples:
        dumped = sample.model_dump(mode="json")
        material.append({
            key: dumped.get(key)
            for key in ("id", "input", "target", "choices", "metadata", "setup", "sandbox", "files")
            if key in dumped
        })
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def distribution_for_reference(reference: str) -> importlib.metadata.Distribution | None:
    if "/" not in reference or reference.endswith(".py") or ".py@" in reference:
        return None
    package = reference.split("/", 1)[0].replace("-", "_")
    candidates = importlib.metadata.packages_distributions().get(package, [])
    if not candidates:
        return None
    return importlib.metadata.distribution(sorted(candidates)[0])


def resolve_source(project_dir: Path, reference: str, task_file: str | None) -> dict[str, Any]:
    distribution = distribution_for_reference(reference)
    if distribution is not None and task_file is None:
        # Installed registry tasks such as inspect_evals/arc_easy expose no task_file through
        # Inspect's public EvalSpec or registry metadata. Bind the complete executable
        # distribution rather than inventing a source filename.
        distribution_sha256 = distribution_content_sha256(distribution)
        return {
            "kind": "installed-package",
            "path": f"{reference.split('/', 1)[0].replace('-', '_')}/",
            "sha256": distribution_sha256,
            "distribution": {
                "name": distribution.metadata["Name"],
                "version": distribution.version,
                "sha256": distribution_sha256,
            },
        }
    if task_file is None:
        raise ValueError("Inspect task exposes no source file or installed distribution identity")
    raw_path = Path(task_file)
    if distribution is not None:
        distribution_root = Path(distribution.locate_file("")).resolve()
        candidate = raw_path if raw_path.is_absolute() else Path(distribution.locate_file(raw_path))
        if not candidate.is_file():
            # Registered package tasks may report a path relative to the distribution root.
            matches = [Path(distribution.locate_file(entry)) for entry in distribution.files or []
                       if str(entry).endswith(task_file)]
            if len(matches) != 1:
                raise ValueError(f"could not bind installed task source {task_file!r}")
            candidate = matches[0]
        candidate = candidate.resolve()
        try:
            distribution_path = candidate.relative_to(distribution_root).as_posix()
        except ValueError as cause:
            raise ValueError("installed Inspect task source resolves outside its distribution") from cause
        return {
            "kind": "installed-package",
            # Never seal a machine-specific site-packages prefix into public method identity.
            "path": distribution_path,
            "sha256": sha256_file(candidate),
            "distribution": {
                "name": distribution.metadata["Name"],
                "version": distribution.version,
                "sha256": distribution_content_sha256(distribution),
            },
        }

    candidate = raw_path if raw_path.is_absolute() else project_dir / raw_path
    candidate = candidate.resolve()
    try:
        relative = candidate.relative_to(project_dir).as_posix()
    except ValueError as cause:
        raise ValueError("local Inspect task source resolves outside the selected project") from cause
    if not candidate.is_file():
        raise ValueError(f"resolved Inspect task source is missing: {relative}")
    return {
        "kind": "project-file",
        "path": relative,
        "sha256": sha256_file(candidate),
        "projectTreeSha256": project_tree_sha256(project_dir),
    }


def resolved_selection_components(
    project_dir: Path,
    reference: str,
    task_args: dict[str, Any],
    spec: Any,
    requested_scorer_names: list[str],
    legacy_single_scorer: bool,
    selected_sample_id: str | int | None = None,
    samples: list[Any] | None = None,
    declared_sandbox: Any | None = None,
    sandbox_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    scorers = list(spec.scorers or [])
    resolved = [scorer.name for scorer in scorers]
    if not scorers:
        raise ValueError("selected Inspect task resolves no scorers")
    if len(set(resolved)) != len(resolved):
        raise ValueError("selected Inspect task has duplicate resolved scorer names")
    if legacy_single_scorer and (len(scorers) != 1 or resolved != requested_scorer_names):
        raise ValueError(
            f"legacy selection requires exactly the named scorer {requested_scorer_names!r}; resolved {resolved!r}"
        )
    if not legacy_single_scorer and any(name not in resolved for name in requested_scorer_names):
        raise ValueError(f"scoring projection names an unresolved scorer; resolved {resolved!r}")
    if sandbox_config is None and spec.sandbox is not None:
        raise ValueError(
            "first-slice selection refuses task-defined sandboxes until their provider/config/image identity can be pinned"
        )
    if sandbox_config is not None:
        if declared_sandbox is None or declared_sandbox.type != "docker" or declared_sandbox.config is not None:
            raise ValueError("the first hosted-sandbox slice requires one task-level docker sandbox with no config")
        expected_effective = {"type": "jinn-oci", "config": sandbox_config}
        if spec.sandbox is None or spec.sandbox.model_dump(mode="json") != expected_effective:
            raise ValueError("Inspect did not resolve the sealed jinn-oci sandbox override")
        for sample in samples or []:
            if sample.sandbox is not None or sample.files or sample.setup:
                raise ValueError("the first hosted-sandbox slice refuses per-sample sandbox, files, and setup")
    dataset = spec.dataset
    attrib_version = spec.task_attribs.get("version") if spec.task_attribs else None
    resolved_version = str(attrib_version) if attrib_version is not None else (
        str(spec.task_version) if spec.task_version is not None else None
    )
    scoring_components = (
        {"scorer": scorers[0].model_dump(mode="json")}
        if legacy_single_scorer
        else {
            "scorers": [scorer.model_dump(mode="json") for scorer in scorers],
            "inspectMetrics": spec.model_dump(mode="json").get("metrics"),
            "inspectEpochReducers": spec.config.epochs_reducer,
        }
    )
    return {
        **scoring_components,
        "task": {
            "reference": reference,
            "args": task_args,
            "resolvedName": spec.task,
            "resolvedVersion": resolved_version,
            **({
                "declaredSandbox": declared_sandbox.model_dump(mode="json"),
                "resolvedSandbox": spec.sandbox.model_dump(mode="json"),
            } if sandbox_config is not None else {"resolvedSandbox": None}),
            "source": resolve_source(project_dir, reference, spec.task_file),
            "dataset": {
                "name": dataset.name,
                "location": dataset.location,
                "samples": dataset.samples,
                **({
                    "selectedSampleId": selected_sample_id,
                    "orderedSampleSha256": selected_samples_sha256(samples),
                } if selected_sample_id is not None and samples is not None else {}),
            },
        },
    }


def configure_sandbox(sandbox_config: dict[str, Any] | None) -> Any | None:
    if sandbox_config is None:
        return None
    from inspect_ai.util import SandboxEnvironmentSpec
    from jinn_inspect_sandbox import JinnOciSandboxConfig

    return SandboxEnvironmentSpec("jinn-oci", JinnOciSandboxConfig.model_validate(sandbox_config))


def declared_sandbox_for_task(
    reference: str,
    task_args: dict[str, Any],
    log_dir: str,
) -> Any | None:
    logs = inspect_eval(
        reference,
        task_args=task_args,
        model="mockllm/jinn-sandbox-metadata",
        run_samples=False,
        log_dir=log_dir,
        log_format="eval",
        display="none",
    )
    if len(logs) != 1:
        raise ValueError("sandbox metadata probe did not resolve exactly one task")
    return read_eval_log(local_path(logs[0].location)).eval.sandbox


def probe(config: dict[str, Any]) -> dict[str, Any]:
    runtime = {
        **require_runtime(),
        "adapterVersion": "1",
        "workerSha256": sha256_file(Path(__file__).resolve()),
        "brokerSha256": sha256_file(Path("/opt/jinn/broker.py")) if Path("/opt/jinn/broker.py").is_file() else None,
        "modelProviderSha256": sha256_file(Path("/opt/jinn/model_provider.py")) if Path("/opt/jinn/model_provider.py").is_file() else None,
        "sandboxProviderSha256": project_tree_sha256(Path("/opt/jinn/sandbox_extension")) if Path("/opt/jinn/sandbox_extension").is_dir() else None,
    }
    project_dir = Path(config["projectDir"]).resolve()
    if not project_dir.is_dir():
        raise ValueError("Inspect projectDir is not a directory")
    reference = config["taskReference"]
    task_args = config.get("taskArgs", {})
    prior_cwd = Path.cwd()
    try:
        os.chdir(project_dir)
        with tempfile.TemporaryDirectory(prefix="jinn-inspect-probe-") as log_dir:
            selected_sample_id = config.get("runOptions", {}).get("sampleId")
            sandbox_config = config.get("sandboxExecution")
            declared_sandbox = declared_sandbox_for_task(
                reference, task_args, str(Path(log_dir) / "declared")
            ) if sandbox_config is not None else None
            logs = inspect_eval(
                reference,
                task_args=task_args,
                model="mockllm/jinn-probe",
                run_samples=selected_sample_id is not None,
                sample_id=selected_sample_id,
                log_dir=log_dir,
                log_format="eval",
                display="none",
                sandbox=configure_sandbox(sandbox_config),
            )
            if len(logs) != 1:
                raise ValueError(f"one task reference must resolve to exactly one EvalLog, got {len(logs)}")
            # Inspect may return a lazy EvalLog whose samples are read from the native log on
            # first access. Resolve the official log and bind its selected sample bytes before
            # the temporary probe directory is removed.
            log = read_eval_log(local_path(logs[0].location))
            components = resolved_selection_components(
                project_dir,
                reference,
                task_args,
                log.eval,
                [config["scorerName"]] if "scorerName" in config else list(config["scorerNames"]),
                "scorerName" in config,
                selected_sample_id,
                list(log.samples or []),
                declared_sandbox,
                sandbox_config,
            )
    finally:
        os.chdir(prior_cwd)
    return {
        "runtime": runtime,
        **components,
    }


def scalar_equal(left: Any, right: Any) -> bool:
    return type(left) is type(right) and left == right


def projected_scalar_equal(left: Any, right: Any) -> bool:
    """Compare in the sealed JSON scalar type system (where integers and floats are numbers)."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    return type(left) is type(right) and left == right


def is_projectable_scalar(value: Any) -> bool:
    if isinstance(value, float):
        return math.isfinite(value)
    return value is None or isinstance(value, (bool, int, str))


def score_value_shape(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "list"
    return "object"


def project_multiple_scorer_observations(
    manifest: dict[str, Any], samples: list[Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    """Bounded observations only; the TypeScript host owns the Jinn verdict."""
    scorer_inventory = []
    for declared in manifest["scorers"]:
        scorer_name = declared["name"]
        present_scores = [
            sample.scores[scorer_name]
            for sample in samples
            if sample.scores is not None and scorer_name in sample.scores
        ]
        shapes = {score_value_shape(score.value) for score in present_scores}
        scorer_inventory.append({
            "name": scorer_name,
            "presentSamples": len(present_scores),
            "missingSamples": len(samples) - len(present_scores),
            "valueShapes": [
                shape for shape in ("null", "boolean", "number", "string", "list", "object")
                if shape in shapes
            ],
        })

    measurements = []
    selected_unscorable = False
    for projection in manifest["scoring"]["projections"]:
        projected_values: list[Any] = []
        missing = 0
        invalid = 0
        for sample in samples:
            score = (sample.scores or {}).get(projection["scorerName"])
            if score is None:
                missing += 1
                continue
            value = score.value
            if "subScoreKey" in projection:
                if not isinstance(value, dict):
                    invalid += 1
                    continue
                if projection["subScoreKey"] not in value:
                    missing += 1
                    continue
                value = value[projection["subScoreKey"]]
            if not is_projectable_scalar(value):
                invalid += 1
                continue
            projected_values.append(value)
        projection_unscorable = missing > 0 or invalid > 0 or not projected_values
        selected_unscorable = selected_unscorable or projection_unscorable
        measurements.append({
            "measurementName": projection["measurementName"],
            "scorerName": projection["scorerName"],
            **({"subScoreKey": projection["subScoreKey"]} if "subScoreKey" in projection else {}),
            "missingSamples": missing,
            "invalidValueSamples": invalid,
            "value": None if projection_unscorable else all(
                projected_scalar_equal(value, projection["passValue"]) for value in projected_values
            ),
        })
    return scorer_inventory, measurements, selected_unscorable


def expected_sample_count(manifest: dict[str, Any], log: Any) -> int | None:
    # Inspect preserves the source dataset cardinality in EvalSpec.dataset.samples even when
    # sample_id selects a single row. The locked exact sample is the cell's expected work.
    return 1 if manifest.get("runOptions", {}).get("sampleId") is not None else log.eval.dataset.samples


def observe_native_log(manifest: dict[str, Any], log: Any, native_log: Path) -> dict[str, Any]:
    """Return the bounded facts shared by execution summaries and separate verification."""
    expected = expected_sample_count(manifest, log)
    samples = log.samples or []
    errors = sum(1 for sample in samples if sample.error is not None)
    incomplete = expected is None or len(samples) != expected
    common = {
        "terminal": "unscorable",
        "inspectStatus": log.status,
        "expectedSamples": expected,
        "observedSamples": len(samples),
        "erroredSamples": errors,
        "invalidated": bool(log.invalidated),
        "nativeLogSha256": sha256_file(native_log),
        "nativeLogBytes": native_log.stat().st_size,
    }
    if "scorer" in manifest:
        scorer_name = manifest["scorer"]["name"]
        pass_value = manifest["scorer"]["passValue"]
        score_values: list[Any] = []
        missing_scores = 0
        for sample in samples:
            score = (sample.scores or {}).get(scorer_name)
            value = None if score is None else score.value
            if score is None or isinstance(value, (list, dict)):
                missing_scores += 1
            else:
                score_values.append(value)
        unscorable = (
            log.status != "success"
            or bool(log.invalidated)
            or errors > 0
            or incomplete
            or missing_scores > 0
            or len(score_values) == 0
        )
        passed = (not unscorable) and all(scalar_equal(value, pass_value) for value in score_values)
        return {
            "schema": "jinn.network/benchmark-product/inspect-log-observation/1",
            "summarySchema": "jinn.network/benchmark-product/inspect-cell-summary/1",
            **common,
            "terminal": "unscorable" if unscorable else "scored",
            "missingScoreSamples": missing_scores,
            "scorer": scorer_name,
            "measurement": None if unscorable else passed,
        }

    scorer_inventory, measurements, selected_unscorable = project_multiple_scorer_observations(
        manifest, samples
    )
    unscorable = (
        log.status != "success"
        or bool(log.invalidated)
        or errors > 0
        or incomplete
        or selected_unscorable
    )
    if unscorable:
        measurements = [{**measurement, "value": None} for measurement in measurements]
    return {
        "schema": "jinn.network/benchmark-product/inspect-log-observation/1",
        "summarySchema": "jinn.network/benchmark-product/inspect-cell-summary/2",
        **common,
        "terminal": "unscorable" if unscorable else "scored",
        "scorers": scorer_inventory,
        "measurements": measurements,
    }


def verify_log_identity(manifest: dict[str, Any], log: Any, selection_sha256: str) -> None:
    """Check identities available in the native log without importing the selected task."""
    dumped = log.eval.model_dump(mode="json")
    task = manifest["task"]
    if dumped.get("task") != task["resolvedName"]:
        raise ValueError("Inspect native log task identity differs from the sealed selection")
    resolved_version = dumped.get("task_attribs", {}).get("version") or dumped.get("task_version")
    if (None if resolved_version is None else str(resolved_version)) != task.get("resolvedVersion"):
        raise ValueError("Inspect native log task version differs from the sealed selection")
    dataset = dumped.get("dataset") or {}
    expected_dataset = task["dataset"]
    for key in ("name", "location", "samples"):
        if dataset.get(key) != expected_dataset.get(key):
            raise ValueError("Inspect native log dataset identity differs from the sealed selection")
    scorers = dumped.get("scorers") or []
    expected_scorers = (
        [manifest["scorer"]["definition"]]
        if "scorer" in manifest
        else [scorer["definition"] for scorer in manifest["scorers"]]
    )
    if scorers != expected_scorers:
        raise ValueError("Inspect native log scorer definitions differ from the sealed selection")
    if "scoring" in manifest:
        if dumped.get("metrics") != manifest["scoring"]["inspectMetrics"]:
            raise ValueError("Inspect native log metric configuration differs from the sealed selection")
        config = dumped.get("config") or {}
        if config.get("epochs_reducer") != manifest["scoring"]["inspectEpochReducers"]:
            raise ValueError("Inspect native log epoch reducers differ from the sealed selection")
    metadata = dumped.get("metadata") or {}
    if metadata.get("jinn.selection_manifest_sha256") != selection_sha256:
        raise ValueError("Inspect native log selection identity is absent or changed")
    arm_id = metadata.get("jinn.arm_id")
    arm = next((candidate for candidate in manifest["arms"] if candidate["armId"] == arm_id), None)
    if arm is None:
        raise ValueError("Inspect native log arm identity is absent or changed")
    if dumped.get("model") != arm["model"]:
        raise ValueError("Inspect native log model identity differs from the sealed arm")
    selected_sample_id = manifest.get("runOptions", {}).get("sampleId")
    if selected_sample_id is not None:
        if len(log.samples or []) != 1 or (log.samples or [None])[0].id != selected_sample_id:
            raise ValueError("Inspect native log selected sample identity differs from the sealed selection")
        if selected_samples_sha256(list(log.samples or [])) != expected_dataset["orderedSampleSha256"]:
            raise ValueError("Inspect native log selected sample bytes differ from the sealed selection")


def verify(config: dict[str, Any]) -> dict[str, Any]:
    """Read and bound one genuine EvalLog without loading task, solver, scorer, or model code."""
    runtime = require_runtime()
    manifest = config["manifest"]
    expected_runtime = manifest["runtime"]
    pinned_runtime_fields = (
        "inspectVersion",
        "inspectWheelSha256",
        "pythonVersion",
        "pythonExecutableSha256",
        "pythonEnvironmentSha256",
        "inspectDistributionSha256",
    )
    if any(runtime.get(field) != expected_runtime.get(field) for field in pinned_runtime_fields):
        raise ValueError("Inspect verifier runtime differs from the sealed selection")
    if sha256_file(Path(__file__).resolve()) != expected_runtime["workerSha256"]:
        raise ValueError("Inspect verifier worker differs from the sealed selection")
    native_log = Path(config["nativeLogPath"]).resolve()
    if not native_log.is_file():
        raise ValueError("Inspect native log is missing")
    log = read_eval_log(native_log)
    verify_log_identity(manifest, log, config["selectionManifestSha256"])
    return observe_native_log(manifest, log, native_log)


def run(config: dict[str, Any]) -> dict[str, Any]:
    require_runtime()
    project_dir = Path(config["projectDir"]).resolve()
    output_dir = Path(config["outputDir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = config["manifest"]
    arm = config["arm"]
    options = manifest.get("runOptions", {})
    provider_records = None
    provider = arm.get("provider")
    if provider is not None:
        sys.path.insert(0, "/opt/jinn")
        import model_provider
        model_provider.configure(config["cellKey"])
        provider_records = model_provider.records
    execution = manifest["runtime"].get("execution")
    sandbox_runtime = execution.get("sandbox") if execution is not None else None
    sandbox_config = None if sandbox_runtime is None else {
        "schema": "jinn.network/benchmark-product/inspect-sandbox/1",
        "imageDigest": sandbox_runtime["imageDigest"],
        "platform": sandbox_runtime["platform"],
        "policySha256": sandbox_runtime["policySha256"],
    }
    kwargs: dict[str, Any] = {
        "task_args": manifest["task"]["args"],
        "model": arm["model"],
        "model_args": {} if provider is not None else arm.get("modelArgs", {}),
        "model_roles": arm.get("modelRoles"),
        "epochs": 1,
        "max_tasks": 1,
        "log_dir": str(output_dir / "logs"),
        "log_format": "eval",
        "display": "none",
        "metadata": {
            "jinn.selection_manifest_sha256": config["selectionManifestSha256"],
            "jinn.cell_key": config["cellKey"],
            "jinn.arm_id": arm["armId"],
            "jinn.repetition": config["repetition"],
        },
        "sandbox": configure_sandbox(sandbox_config),
    }
    if provider is not None:
        # These are Inspect GenerateConfig fields (eval **kwargs), not ModelAPI constructor
        # arguments. Keeping the two channels separate is required by Inspect's public API.
        kwargs.update({
            "reasoning_effort": provider["reasoningEffort"],
            "max_tokens": provider["maxOutputTokens"],
            "max_retries": 0,
            "timeout": 120,
        })
    option_names = {
        "sampleId": "sample_id",
        "maxSamples": "max_samples",
        "maxSubprocesses": "max_subprocesses",
        "maxSandboxes": "max_sandboxes",
        "retryOnError": "retry_on_error",
        "failOnError": "fail_on_error",
        "messageLimit": "message_limit",
        "tokenLimit": "token_limit",
        "timeLimit": "time_limit",
    }
    for manifest_name, inspect_name in option_names.items():
        if manifest_name in options:
            kwargs[inspect_name] = options[manifest_name]

    prior_cwd = Path.cwd()
    try:
        os.chdir(project_dir)
        with tempfile.TemporaryDirectory(prefix="jinn-inspect-declared-") as declared_log_dir:
            declared_sandbox = declared_sandbox_for_task(
                manifest["task"]["reference"], manifest["task"]["args"], declared_log_dir
            ) if sandbox_config is not None else None
        logs = inspect_eval(manifest["task"]["reference"], **kwargs)
    finally:
        os.chdir(prior_cwd)
    if len(logs) != 1:
        raise ValueError(f"Inspect returned {len(logs)} logs for one selected task")

    source_log = local_path(logs[0].location)
    # Official reader acceptance is part of the runtime boundary, not deferred to publication.
    log = read_eval_log(source_log)
    runtime_now = require_runtime()
    actual_runtime = {
        **{key: runtime_now[key] for key in (
            "inspectVersion",
            "inspectWheelSha256",
            "pythonVersion",
            "pythonExecutableSha256",
            "pythonEnvironmentSha256",
            "inspectDistributionSha256",
        )},
        "adapterVersion": "1",
        "workerSha256": sha256_file(Path(__file__).resolve()),
    }
    if execution is not None:
        if runtime_now.get("inspectEvalsVersion") != execution["inspectEvalsVersion"]:
            raise ValueError("Inspect Evals package drifted during OCI execution")
        if runtime_now.get("openaiSdkVersion") != execution["openaiSdkVersion"]:
            raise ValueError("OpenAI SDK package drifted during OCI execution")
        if actual_runtime["workerSha256"] != execution["workerSourceSha256"]:
            raise ValueError("OCI worker source drifted from the sealed runtime identity")
        if sha256_file(Path("/opt/jinn/broker.py")) != execution["brokerSourceSha256"]:
            raise ValueError("OCI broker source drifted from the sealed runtime identity")
        if sha256_file(Path("/opt/jinn/model_provider.py")) != execution["modelProviderSourceSha256"]:
            raise ValueError("OCI model provider source drifted from the sealed runtime identity")
        if execution.get("sandbox") is not None:
            if project_tree_sha256(Path("/opt/jinn/sandbox_extension")) != execution["sandbox"]["providerSourceSha256"]:
                raise ValueError("OCI sandbox provider source drifted from the sealed runtime identity")
        actual_runtime["execution"] = execution
    actual_components = resolved_selection_components(
        project_dir,
        manifest["task"]["reference"],
        manifest["task"]["args"],
        log.eval,
        [manifest["scorer"]["name"]] if "scorer" in manifest else [
            projection["scorerName"] for projection in manifest["scoring"]["projections"]
        ],
        "scorer" in manifest,
        manifest.get("runOptions", {}).get("sampleId"),
        log.samples,
        declared_sandbox,
        sandbox_config,
    )
    expected_components = {"task": manifest["task"]}
    if "scorer" in manifest:
        expected_components["scorer"] = manifest["scorer"]["definition"]
    else:
        expected_components.update({
            "scorers": [scorer["definition"] for scorer in manifest["scorers"]],
            "inspectMetrics": manifest["scoring"]["inspectMetrics"],
            "inspectEpochReducers": manifest["scoring"]["inspectEpochReducers"],
        })
    if actual_runtime != manifest["runtime"] or actual_components != expected_components:
        raise ValueError("Inspect runtime, task, source, scorer, dataset, or environment drifted during execution")
    native_log = output_dir / "inspect.eval"
    shutil.copyfile(source_log, native_log)
    reread = read_eval_log(native_log)
    if reread.status != log.status:
        raise ValueError("copied native log changed status under the official Inspect reader")

    samples = log.samples or []
    evaluated_at = __import__("datetime").datetime.now(__import__("datetime").timezone.utc) \
        .isoformat(timespec="milliseconds").replace("+00:00", "Z")
    observed = observe_native_log(manifest, log, native_log)
    if observed["summarySchema"] == "jinn.network/benchmark-product/inspect-cell-summary/1":
        summary = {
            "schema": "jinn.network/benchmark-product/inspect-cell-summary/1",
            **{key: value for key, value in observed.items() if key not in {"schema", "summarySchema"}},
            "verdict": None if observed["terminal"] == "unscorable" else (
                "pass" if observed["measurement"] else "fail"
            ),
            "evaluatedAt": evaluated_at,
        }
    else:
        summary = {
            "schema": "jinn.network/benchmark-product/inspect-cell-summary/2",
            **{key: value for key, value in observed.items() if key not in {"schema", "summarySchema"}},
            "verdict": None,
            "evaluatedAt": evaluated_at,
        }
    if provider_records is not None:
        records = provider_records()
        summary["provider"] = {
            "surface": provider["surface"],
            "resolvedModel": records[-1].get("resolvedModel") if records else None,
            "callCount": len(records),
            "usage": records[-1].get("usage") if records else None,
            "terminalStatus": records[-1].get("status") if records else "no-call",
            "eventDigest": records[-1].get("eventDigest") if records else None,
            "brokerProtocol": "jinn.network/model-broker/1",
            "brokerSourceSha256": manifest["runtime"]["execution"]["brokerSourceSha256"],
        }
    if sandbox_runtime is not None:
        sandbox_events = [
            event for sample in samples for event in (sample.events or [])
            if getattr(event, "event", None) == "sandbox"
        ]
        event_material = json.dumps(
            [event.model_dump(mode="json") for event in sandbox_events],
            sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        ).encode("utf-8")
        summary["sandbox"] = {
            "provider": sandbox_runtime["provider"],
            "protocol": sandbox_runtime["protocol"],
            "imageDigest": sandbox_runtime["imageDigest"],
            "environmentCount": 1,
            "operationCount": len(sandbox_events),
            "eventDigest": hashlib.sha256(event_material).hexdigest(),
        }
    (output_dir / "inspect-summary.json").write_text(
        json.dumps(summary, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    return summary


def specified_epochs_from_spec(spec: Any) -> tuple[int, str | None]:
    config_obj = getattr(spec, "config", None)
    if config_obj is None:
        return 1, None
    raw = getattr(config_obj, "epochs", None)
    reducer = getattr(config_obj, "epochs_reducer", None)
    reducer_out: str | None = None
    if isinstance(reducer, str):
        reducer_out = reducer
    elif isinstance(reducer, list) and reducer:
        reducer_out = str(reducer[0])
    elif reducer is not None:
        reducer_out = str(reducer)
    if raw is None:
        return 1, reducer_out
    if isinstance(raw, int) and raw >= 1:
        return raw, reducer_out
    inner = getattr(raw, "epochs", None)
    inner_reducer = getattr(raw, "reducer", None)
    if inner_reducer is not None and reducer_out is None:
        reducer_out = str(inner_reducer)
    if isinstance(inner, int) and inner >= 1:
        return inner, reducer_out
    return 1, reducer_out


def sample_id_from(sample: Any) -> str | int:
    sample_id = getattr(sample, "id", None)
    if sample_id is None and isinstance(sample, dict):
        sample_id = sample.get("id")
    if sample_id is None:
        raise ValueError("Inspect catalog sample is missing an id")
    if not isinstance(sample_id, (str, int)) or isinstance(sample_id, bool):
        return str(sample_id)
    return sample_id


def catalog_sample_ids(log: Any, reference: str, task_args: dict[str, Any]) -> list[str | int]:
    samples = list(log.samples or [])
    if samples:
        return [sample_id_from(sample) for sample in samples]
    try:
        from inspect_ai._eval.loader import load_tasks
        tasks = load_tasks([reference], task_args=task_args)
        if len(tasks) == 1 and getattr(tasks[0], "dataset", None) is not None:
            samples = list(tasks[0].dataset)
    except Exception:
        samples = []
    if not samples:
        raise ValueError("Inspect catalog probe produced no sample ids")
    return [sample_id_from(sample) for sample in samples]


def catalog(config: dict[str, Any]) -> dict[str, Any]:
    project_dir = Path(config["projectDir"]).resolve()
    if not project_dir.is_dir():
        raise ValueError("Inspect projectDir is not a directory")
    reference = config["taskReference"]
    task_args = config.get("taskArgs", {})
    prior_cwd = Path.cwd()
    try:
        os.chdir(project_dir)
        with tempfile.TemporaryDirectory(prefix="jinn-inspect-catalog-") as log_dir:
            logs = inspect_eval(
                reference,
                task_args=task_args,
                model="mockllm/jinn-catalog",
                run_samples=False,
                log_dir=log_dir,
                log_format="eval",
                display="none",
            )
            if len(logs) != 1:
                raise ValueError(f"one task reference must resolve to exactly one EvalLog, got {len(logs)}")
            log = read_eval_log(local_path(logs[0].location))
            sample_ids = catalog_sample_ids(log, reference, task_args)
            specified_epochs, epochs_reducer = specified_epochs_from_spec(log.eval)
            attrib_version = log.eval.task_attribs.get("version") if log.eval.task_attribs else None
            task_version = str(attrib_version) if attrib_version is not None else (
                str(log.eval.task_version) if log.eval.task_version is not None else None
            )
            dataset = log.eval.dataset
            return {
                "sampleIds": sample_ids,
                "specifiedEpochs": specified_epochs,
                "epochsReducer": epochs_reducer,
                "taskVersion": task_version,
                "datasetName": dataset.name if dataset is not None else None,
                "datasetLocation": dataset.location if dataset is not None else None,
                "datasetSampleCount": dataset.samples if dataset is not None and dataset.samples is not None else len(sample_ids),
            }
    finally:
        os.chdir(prior_cwd)


def main() -> int:
    if len(sys.argv) not in {2, 3} or sys.argv[1] not in {"probe", "run", "verify", "catalog"}:
        print(json.dumps({"ok": False, "error": "usage: worker.py probe|run|verify|catalog [config.json]"}))
        return 2
    try:
        prepare_readonly_hf_dataset_cache()
        config = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")) if len(sys.argv) == 3 else json.load(sys.stdin)
        # Task imports and model/scorer code may print. Keep stdout reserved for the bounded
        # worker protocol; the host captures and discards stderr rather than reflecting it.
        with redirect_stdout(sys.stderr):
            value = (
                probe(config) if sys.argv[1] == "probe"
                else verify(config) if sys.argv[1] == "verify"
                else catalog(config) if sys.argv[1] == "catalog"
                else run(config)
            )
        print(json.dumps({"ok": True, "value": value}, sort_keys=True, separators=(",", ":")))
        return 0
    except BaseException as error:
        # Arbitrary task/provider exceptions can embed prompts, responses, secrets, account data,
        # and host paths in their message. Keep the protocol diagnostic fixed and send neither
        # the exception text nor a traceback across the trusted boundary.
        del error
        print(json.dumps({"ok": False, "error": f"Inspect worker {sys.argv[1]} failed"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
