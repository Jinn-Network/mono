#!/usr/bin/env python3
"""Pinned Inspect 0.3.255 worker. Arbitrary task code runs only in this child process."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
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
    scorer_name: str,
    selected_sample_id: str | int | None = None,
    samples: list[Any] | None = None,
    declared_sandbox: Any | None = None,
    sandbox_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if len(spec.scorers) != 1 or spec.scorers[0].name != scorer_name:
        resolved = [scorer.name for scorer in spec.scorers]
        raise ValueError(
            f"first-slice selection requires exactly the named scorer {scorer_name!r}; resolved {resolved!r}"
        )
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
    return {
        "scorer": spec.scorers[0].model_dump(mode="json"),
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
                config["scorerName"],
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
        manifest["scorer"]["name"],
        manifest.get("runOptions", {}).get("sampleId"),
        log.samples,
        declared_sandbox,
        sandbox_config,
    )
    if actual_runtime != manifest["runtime"] or actual_components != {
        "task": manifest["task"],
        "scorer": manifest["scorer"]["definition"],
    }:
        raise ValueError("Inspect runtime, task, source, scorer, dataset, or environment drifted during execution")
    native_log = output_dir / "inspect.eval"
    shutil.copyfile(source_log, native_log)
    reread = read_eval_log(native_log)
    if reread.status != log.status:
        raise ValueError("copied native log changed status under the official Inspect reader")

    # Inspect preserves the source dataset cardinality in EvalSpec.dataset.samples even when
    # sample_id selects a single row. The locked exact sample is the cell's expected work; using
    # the source cardinality here would incorrectly mark every exact-sample run incomplete.
    expected = 1 if options.get("sampleId") is not None else log.eval.dataset.samples
    samples = log.samples or []
    errors = sum(1 for sample in samples if sample.error is not None)
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
    incomplete = expected is None or len(samples) != expected
    unscorable = (
        log.status != "success"
        or bool(log.invalidated)
        or errors > 0
        or incomplete
        or missing_scores > 0
        or len(score_values) == 0
    )
    passed = (not unscorable) and all(scalar_equal(value, pass_value) for value in score_values)
    summary = {
        "schema": "jinn.network/benchmark-product/inspect-cell-summary/1",
        "terminal": "unscorable" if unscorable else "scored",
        "inspectStatus": log.status,
        "expectedSamples": expected,
        "observedSamples": len(samples),
        "erroredSamples": errors,
        "missingScoreSamples": missing_scores,
        "invalidated": bool(log.invalidated),
        "scorer": scorer_name,
        "verdict": None if unscorable else ("pass" if passed else "fail"),
        "measurement": None if unscorable else passed,
        "evaluatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "nativeLogSha256": sha256_file(native_log),
        "nativeLogBytes": native_log.stat().st_size,
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


def main() -> int:
    if len(sys.argv) not in {2, 3} or sys.argv[1] not in {"probe", "run"}:
        print(json.dumps({"ok": False, "error": "usage: worker.py probe|run [config.json]"}))
        return 2
    try:
        prepare_readonly_hf_dataset_cache()
        config = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")) if len(sys.argv) == 3 else json.load(sys.stdin)
        # Task imports and model/scorer code may print. Keep stdout reserved for the bounded
        # worker protocol; the host captures and discards stderr rather than reflecting it.
        with redirect_stdout(sys.stderr):
            value = probe(config) if sys.argv[1] == "probe" else run(config)
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
