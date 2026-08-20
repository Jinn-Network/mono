"""Inspect public ModelAPI extension for the narrow Jinn OpenAI broker."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time
from typing import Any
from urllib.request import Request, urlopen
import uuid

import anyio
from inspect_ai.model import (
    ChatMessageSystem,
    ChatMessageUser,
    ModelAPI,
    ModelCall,
    model_output_from_openai_responses,
    modelapi,
)


BROKER_URL = "http://jinn-model-broker:8765/v1/generate-text"
CAPABILITY_PATH = Path("/run/jinn/broker-capability")
PROTOCOL = "jinn.network/model-broker/1"
# Mirrors JUDGE_MODEL_PROFILES from
# packages/task-execution/profiles/src/binary-judgment/contracts.ts (spec §1.1/§1.2). Both copies
# widen in the same PR.
JUDGE_MODEL_PROFILES = {
    "gpt-5.6-luna": "reasoning-2026-08",
    "gpt-4o-mini-2024-07-18": "dated-snapshot-sampling",
}
ACCEPTED_MODELS = frozenset(JUDGE_MODEL_PROFILES)
MAX_OUTPUT_TOKENS_BY_PROFILE = {
    "reasoning-2026-08": 128,
    "dated-snapshot-sampling": 512,
}
_cell_key = "unconfigured"
_records: list[dict[str, Any]] = []


def configure(cell_key: str) -> None:
    global _cell_key, _records
    _cell_key = cell_key
    _records = []


def records() -> list[dict[str, Any]]:
    return list(_records)


def text_content(message: ChatMessageSystem | ChatMessageUser) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for item in content:
        dumped = item.model_dump(mode="json")
        if dumped.get("type") != "text" or not isinstance(dumped.get("text"), str):
            raise ValueError("jinn-openai accepts text content only")
        parts.append(dumped["text"])
    return "".join(parts)


def broker_call(value: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    request = Request(BROKER_URL, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=120) as response:
        if response.status != 200:
            raise RuntimeError("Jinn model broker rejected the request")
        decoded = json.loads(response.read(1_000_000))
    if not isinstance(decoded, dict) or decoded.get("protocol") != PROTOCOL:
        raise RuntimeError("Jinn model broker returned a malformed response")
    return decoded


@modelapi(name="jinn-openai")
class JinnOpenAIModelAPI(ModelAPI):
    def should_retry(self, _exception: Exception) -> bool:
        return False

    async def generate(self, input, tools, tool_choice, config):
        if self.model_name not in ACCEPTED_MODELS or tools or tool_choice != "none":
            raise ValueError("jinn-openai supports only the locked judge models without tools")
        model = self.model_name
        profile = JUDGE_MODEL_PROFILES[model]
        max_output_tokens = MAX_OUTPUT_TOKENS_BY_PROFILE[profile]
        messages: list[dict[str, str]] = []
        for message in input:
            if isinstance(message, ChatMessageSystem):
                messages.append({"role": "developer", "text": text_content(message)})
            elif isinstance(message, ChatMessageUser):
                messages.append({"role": "user", "text": text_content(message)})
            else:
                raise ValueError("jinn-openai refuses assistant and tool history")
        if profile == "reasoning-2026-08":
            effort = config.reasoning_effort
            expected_config = {
                "max_retries": 0,
                "max_tokens": max_output_tokens,
                "reasoning_effort": effort,
                "timeout": 120,
            }
            if (
                effort not in {"none", "low"}
                or config.model_dump(mode="json", exclude_none=True) != expected_config
            ):
                raise ValueError("Inspect generation configuration drifted from the sealed judge arm")
            generation = {
                "reasoningEffort": effort,
                "maxOutputTokens": max_output_tokens,
                "store": False,
                "background": False,
                "stream": False,
                "serviceTier": "default",
            }
        else:
            temperature = config.temperature
            expected_config = {
                "max_retries": 0,
                "max_tokens": max_output_tokens,
                "temperature": temperature,
                "timeout": 120,
            }
            # config.temperature comes from Inspect's own pydantic-typed GenerateConfig, not raw
            # JSON, so it may be coerced to float; guard against bool explicitly rather than
            # requiring the Python type to be exactly int (contrast with the wire-format checks in
            # broker.py / binary_judge_worker.py, which do require the literal JSON integer 0).
            if (
                isinstance(temperature, bool)
                or temperature != 0
                or config.model_dump(mode="json", exclude_none=True) != expected_config
            ):
                raise ValueError("Inspect generation configuration drifted from the sealed judge arm")
            generation = {
                "temperature": 0,
                "maxOutputTokens": max_output_tokens,
                "store": False,
                "background": False,
                "stream": False,
                "serviceTier": "default",
            }
        capability = CAPABILITY_PATH.read_text(encoding="utf-8").strip()
        correlation = f"{_cell_key}:{len(_records) + 1}:{uuid.uuid4()}"
        envelope = {
            "operation": f"{PROTOCOL}:generateText",
            "correlationId": correlation,
            "capability": capability,
            "model": model,
            "messages": messages,
            "generation": generation,
        }
        started = time.monotonic()
        result = await anyio.to_thread.run_sync(broker_call, envelope)
        status = result.get("status")
        record = {
            "status": status,
            "resolvedModel": result.get("resolvedModel"),
            "responseId": result.get("responseId"),
            "usage": result.get("usage"),
            "eventDigest": result.get("eventDigest"),
        }
        _records.append(record)
        if status != "completed":
            raise RuntimeError(f"Jinn model broker terminal: {status}")
        response_body = result.get("responseBody")
        if not isinstance(response_body, dict) or result.get("resolvedModel") != model:
            raise RuntimeError("Jinn model broker response conflicts with the locked model")
        upstream_request: dict[str, Any] = {
            "model": model,
            "input": [
                {"role": message["role"], "content": [{"type": "input_text", "text": message["text"]}]}
                for message in messages
            ],
            "max_output_tokens": max_output_tokens,
            "store": False,
            "background": False,
            "stream": False,
            "service_tier": "default",
            "tools": [],
            "tool_choice": "none",
        }
        if profile == "reasoning-2026-08":
            upstream_request["reasoning"] = {"effort": effort}
        else:
            upstream_request["temperature"] = 0
        output = await model_output_from_openai_responses(response_body)
        call = ModelCall(
            request=upstream_request,
            response=response_body,
            time=time.monotonic() - started,
            call_key=hashlib.sha256(correlation.encode("utf-8")).hexdigest(),
        )
        return output, call
