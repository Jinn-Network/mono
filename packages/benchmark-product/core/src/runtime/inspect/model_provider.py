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
MODEL = "gpt-5.6-luna"
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
        if self.model_name != MODEL or tools or tool_choice != "none":
            raise ValueError("jinn-openai supports only the locked Luna text model without tools")
        messages: list[dict[str, str]] = []
        for message in input:
            if isinstance(message, ChatMessageSystem):
                messages.append({"role": "developer", "text": text_content(message)})
            elif isinstance(message, ChatMessageUser):
                messages.append({"role": "user", "text": text_content(message)})
            else:
                raise ValueError("jinn-openai refuses assistant and tool history")
        effort = config.reasoning_effort
        expected_config = {
            "max_retries": 0,
            "max_tokens": 128,
            "reasoning_effort": effort,
            "timeout": 120,
        }
        if (
            effort not in {"none", "low"}
            or config.model_dump(mode="json", exclude_none=True) != expected_config
        ):
            raise ValueError("Inspect generation configuration drifted from the sealed Luna arm")
        capability = CAPABILITY_PATH.read_text(encoding="utf-8").strip()
        correlation = f"{_cell_key}:{len(_records) + 1}:{uuid.uuid4()}"
        envelope = {
            "operation": f"{PROTOCOL}:generateText",
            "correlationId": correlation,
            "capability": capability,
            "model": MODEL,
            "messages": messages,
            "generation": {
                "reasoningEffort": effort,
                "maxOutputTokens": 128,
                "store": False,
                "background": False,
                "stream": False,
                "serviceTier": "default",
            },
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
        if not isinstance(response_body, dict) or result.get("resolvedModel") != MODEL:
            raise RuntimeError("Jinn model broker response conflicts with the locked model")
        upstream_request = {
            "model": MODEL,
            "input": [
                {"role": message["role"], "content": [{"type": "input_text", "text": message["text"]}]}
                for message in messages
            ],
            "reasoning": {"effort": effort},
            "max_output_tokens": 128,
            "store": False,
            "background": False,
            "stream": False,
            "service_tier": "default",
            "tools": [],
            "tool_choice": "none",
        }
        output = await model_output_from_openai_responses(response_body)
        call = ModelCall(
            request=upstream_request,
            response=response_body,
            time=time.monotonic() - started,
            call_key=hashlib.sha256(correlation.encode("utf-8")).hexdigest(),
        )
        return output, call
