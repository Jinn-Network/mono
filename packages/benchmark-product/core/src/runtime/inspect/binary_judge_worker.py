#!/usr/bin/env python3
"""One-sample Inspect launcher for the closed binary-judgment v1 Task profile."""

from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import sys
from typing import Any
from urllib.parse import unquote, urlparse


PROTOCOL = "https://spec.jinn.network/binary-judgment/judge-observation/v1"
MODEL = "gpt-5.6-luna"
RESPONSE_MEDIA_TYPE = "text/plain; charset=utf-8"
SUPPORTED = {
    "inspect-ai": "0.3.255",
    "inspect-evals": "0.16.0",
    "openai": "2.53.0",
}
GENERATION_KEYS = {
    "reasoningEffort", "maxOutputTokens", "store", "background", "stream",
    "serviceTier", "tools", "fallbackModels", "retries", "persistedConversation",
    "metadata", "promptCacheIdentifier",
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def local_path(location: str) -> Path:
    parsed = urlparse(location)
    if parsed.scheme in ("", "file"):
        return Path(unquote(parsed.path if parsed.scheme else location)).resolve()
    raise ValueError("Inspect binary-judge log is not local")


def require_runtime(manifest: dict[str, Any]) -> None:
    runtime = manifest["runtime"]
    for package, version in SUPPORTED.items():
        if importlib.metadata.version(package) != version:
            raise ValueError("Inspect binary-judge package version drifted")
    if runtime["pythonVersion"] != ".".join(str(value) for value in sys.version_info[:3]):
        raise ValueError("Inspect binary-judge Python version drifted")
    for path, field in (
        (Path("/opt/jinn/binary_judge_worker.py"), "workerSourceSha256"),
        (Path("/opt/jinn/broker.py"), "brokerSourceSha256"),
        (Path("/opt/jinn/model_provider.py"), "modelProviderSourceSha256"),
    ):
        if sha256_file(path) != runtime[field]:
            raise ValueError("Inspect binary-judge runtime source drifted")


def validate_semantic_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"model", "messages", "generation"}:
        raise ValueError("semantic request fields drifted")
    if value["model"] != MODEL:
        raise ValueError("semantic request model drifted")
    messages = value["messages"]
    if not isinstance(messages, list) or not messages:
        raise ValueError("semantic request messages are empty")
    for message in messages:
        if (
            not isinstance(message, dict)
            or set(message) != {"role", "text"}
            or message["role"] not in {"developer", "user"}
            or not isinstance(message["text"], str)
        ):
            raise ValueError("semantic request message drifted")
    generation = value["generation"]
    if not isinstance(generation, dict) or set(generation) != GENERATION_KEYS:
        raise ValueError("semantic request generation fields drifted")
    expected = {
        "maxOutputTokens": 128,
        "store": False,
        "background": False,
        "stream": False,
        "serviceTier": "default",
        "tools": [],
        "fallbackModels": [],
        "retries": 0,
        "persistedConversation": False,
        "metadata": None,
        "promptCacheIdentifier": None,
    }
    if generation.get("reasoningEffort") not in {"none", "low"}:
        raise ValueError("semantic request reasoning effort drifted")
    if any(generation.get(key) != expected_value for key, expected_value in expected.items()):
        raise ValueError("semantic request generation policy drifted")
    return value


def normalized_usage(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        raise ValueError("broker usage material is absent")
    input_tokens = value.get("input_tokens")
    output_tokens = value.get("output_tokens")
    total_tokens = value.get("total_tokens")
    if not all(isinstance(item, int) and not isinstance(item, bool) and item >= 0 for item in (
        input_tokens, output_tokens, total_tokens
    )):
        raise ValueError("broker usage material is malformed")
    if total_tokens != input_tokens + output_tokens:
        raise ValueError("broker token total is inconsistent")
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
    }


def build_observation(config: dict[str, Any], response: bytes, record: dict[str, Any]) -> dict[str, Any]:
    response_id = record.get("responseId")
    event_digest = record.get("eventDigest")
    if (
        record.get("status") != "completed"
        or record.get("resolvedModel") != MODEL
        or not isinstance(response_id, str)
        or not response_id
        or not isinstance(event_digest, str)
        or len(event_digest) != 64
        or any(character not in "0123456789abcdef" for character in event_digest)
    ):
        raise ValueError("broker event material conflicts with the judge contract")
    return {
        "protocol": PROTOCOL,
        "taskDigest": config["taskDigest"],
        "armId": config["armId"],
        "replicate": config["replicate"],
        "instrumentSha256": config["instrumentSha256"],
        "requestSha256": config["requestSha256"],
        "response": {
            "digest": f"sha256:{sha256_bytes(response)}",
            "mediaType": RESPONSE_MEDIA_TYPE,
        },
        "provider": {
            "requestedModel": MODEL,
            "resolvedModel": MODEL,
            "responseId": response_id,
            "eventSha256": f"sha256:{event_digest}",
            "usage": normalized_usage(record.get("usage")),
        },
        "call": {"count": 1, "retries": 0, "fallbacks": 0},
        "limitations": ["mutable-model-alias"],
    }


def run(config: dict[str, Any]) -> dict[str, Any]:
    require_runtime(config["manifest"])
    request = validate_semantic_request(config["semanticRequest"])
    if config["requestSha256"] != f"sha256:{sha256_bytes(canonical_bytes(request))}":
        raise ValueError("semantic request digest drifted")
    arm = config["arm"]
    if (
        arm["armId"] != config["armId"]
        or arm["instrumentSha256"] != config["instrumentSha256"]
        or arm["model"] != MODEL
        or arm["generation"] != request["generation"]
    ):
        raise ValueError("arm, instrument, model, or generation binding drifted")
    if config.get("outputDir") != "/jinn/output":
        raise ValueError("Inspect binary-judge output mount drifted")
    output_dir = Path(config["outputDir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, "/opt/jinn")
    import model_provider
    from inspect_ai import Task, eval as inspect_eval
    from inspect_ai.dataset import MemoryDataset, Sample
    from inspect_ai.model import ChatMessageSystem, ChatMessageUser
    from inspect_ai.solver import generate

    model_provider.configure(config["cellKey"])
    inspect_messages = [
        ChatMessageSystem(content=message["text"])
        if message["role"] == "developer"
        else ChatMessageUser(content=message["text"])
        for message in request["messages"]
    ]
    task = Task(
        dataset=MemoryDataset([Sample(id="binary-judgment", input=inspect_messages)]),
        solver=[generate()],
        scorer=None,
        name="jinn_binary_judgment",
    )
    logs = inspect_eval(
        task,
        model="jinn-openai/gpt-5.6-luna",
        epochs=1,
        max_tasks=1,
        max_samples=1,
        max_subprocesses=1,
        retry_on_error=0,
        fail_on_error=True,
        log_dir=str(output_dir / "logs"),
        log_format="eval",
        display="none",
        metadata={
            "jinn.selection_manifest_sha256": config["selectionManifestSha256"],
            "jinn.cell_key": config["cellKey"],
            "jinn.task_digest": config["taskDigest"],
            "jinn.arm_id": config["armId"],
            "jinn.repetition": config["replicate"],
            "jinn.instrument_sha256": config["instrumentSha256"],
            "jinn.semantic_request_sha256": config["requestSha256"],
        },
        reasoning_effort=request["generation"]["reasoningEffort"],
        max_tokens=128,
        max_retries=0,
        timeout=120,
    )
    if len(logs) != 1:
        raise ValueError("Inspect binary judge returned more than one log")
    from inspect_ai.log import read_eval_log
    native_source = local_path(logs[0].location)
    log = read_eval_log(native_source)
    samples = list(log.samples or [])
    records = model_provider.records()
    if log.status != "success" or len(samples) != 1 or samples[0].error is not None or len(records) != 1:
        raise ValueError("Inspect binary judge did not complete exactly one broker call/sample")
    completion = samples[0].output.completion
    if not isinstance(completion, str):
        raise ValueError("Inspect binary judge produced no text completion")
    response = completion.encode("utf-8")
    observation = build_observation(config, response, records[0])
    (output_dir / "judge-response").write_bytes(response)
    (output_dir / "judge-observation").write_bytes(canonical_bytes(observation))
    shutil.copyfile(native_source, output_dir / "inspect-log")
    shutil.rmtree(output_dir / "logs")
    return observation


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "run":
        print(json.dumps({"ok": False, "error": "usage: binary_judge_worker.py run config.json"}))
        return 2
    try:
        config = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        with redirect_stdout(sys.stderr):
            value = run(config)
        print(json.dumps({"ok": True, "value": value}, sort_keys=True, separators=(",", ":")))
        return 0
    except BaseException as error:
        del error
        print(json.dumps({"ok": False, "error": "Inspect binary-judge worker failed"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
