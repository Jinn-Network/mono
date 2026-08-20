#!/usr/bin/env python3
"""Trusted, single-attempt OpenAI Responses broker for the Inspect OCI worker."""

from __future__ import annotations

import hashlib
import hmac
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
)
from openai.types.responses import Response


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
SECRET_PATH = Path("/run/secrets/openai-api-key")
CAPABILITY_PATH = Path("/run/jinn/broker-capability")
MAX_REQUEST_BYTES = 65_536
MAX_INPUT_BYTES = 32_768
TIMEOUT_SECONDS = 120


class BrokerStartupError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def validate_request(value: Any, expected_capability: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "operation", "correlationId", "capability", "model", "messages", "generation"
    }:
        raise ValueError("request fields are not the broker v1 allowlist")
    if value["operation"] != f"{PROTOCOL}:generateText":
        raise ValueError("unsupported broker operation")
    capability = value["capability"]
    if not isinstance(capability, str) or not hmac.compare_digest(capability, expected_capability):
        raise PermissionError("invalid per-attempt capability")
    model = value["model"]
    if model not in ACCEPTED_MODELS:
        raise ValueError("model is outside the locked broker allowlist")
    profile = JUDGE_MODEL_PROFILES[model]
    max_output_tokens = MAX_OUTPUT_TOKENS_BY_PROFILE[profile]
    correlation = value["correlationId"]
    if not isinstance(correlation, str) or not (1 <= len(correlation) <= 256):
        raise ValueError("invalid correlation id")
    messages = value["messages"]
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages must be a non-empty ordered list")
    input_bytes = 0
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "text"}:
            raise ValueError("messages accept only role and text")
        if message["role"] not in {"developer", "user"} or not isinstance(message["text"], str):
            raise ValueError("messages accept only developer/user text")
        input_bytes += len(message["text"].encode("utf-8"))
    if input_bytes > MAX_INPUT_BYTES:
        raise ValueError("input byte budget exceeded")
    generation = value["generation"]
    if profile == "reasoning-2026-08":
        if not isinstance(generation, dict) or generation != {
            "reasoningEffort": generation.get("reasoningEffort"),
            "maxOutputTokens": max_output_tokens,
            "store": False,
            "background": False,
            "stream": False,
            "serviceTier": "default",
        } or generation.get("reasoningEffort") not in {"none", "low"}:
            raise ValueError("generation configuration differs from the locked allowlist")
    else:
        # isinstance(True, int) is True in Python, so a stray bool masquerading as the literal
        # temperature 0 must be rejected by type, not just by value.
        temperature = generation.get("temperature") if isinstance(generation, dict) else None
        if not isinstance(generation, dict) or generation != {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
            "store": False,
            "background": False,
            "stream": False,
            "serviceTier": "default",
        } or type(temperature) is not int or temperature != 0:
            raise ValueError("generation configuration differs from the locked allowlist")
    return value


class BrokerState:
    def __init__(self) -> None:
        try:
            self.capability = CAPABILITY_PATH.read_text(encoding="utf-8").strip()
            api_key = SECRET_PATH.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise BrokerStartupError("secret-mount-unreadable") from error
        if not self.capability or not api_key:
            raise BrokerStartupError("secret-material-empty")
        try:
            self.client = OpenAI(
                api_key=api_key,
                base_url="https://api.openai.com/v1",
                max_retries=0,
                timeout=TIMEOUT_SECONDS,
            )
        except BaseException as error:
            raise BrokerStartupError("openai-client-configuration") from error
        fake_response_path = os.environ.get("JINN_BROKER_FAKE_RESPONSE_PATH")
        self.fake_response = None
        if fake_response_path is not None:
            if fake_response_path != "/run/secrets/fake-response.json":
                raise BrokerStartupError("test-response-path")
            try:
                candidate = json.loads(Path(fake_response_path).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise BrokerStartupError("test-response-unreadable") from error
            if not isinstance(candidate, dict):
                raise BrokerStartupError("test-response-malformed")
            self.fake_response = candidate
        self.lock = threading.Lock()
        self.call_count = 0

    def generate(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.lock.acquire(blocking=False):
            return terminal("budget-rejected", detail="concurrency budget exhausted")
        started = time.monotonic()
        try:
            if self.call_count >= 1:
                return terminal("budget-rejected", detail="one-call budget exhausted")
            self.call_count += 1
            model = request["model"]
            profile = JUDGE_MODEL_PROFILES[model]
            max_output_tokens = MAX_OUTPUT_TOKENS_BY_PROFILE[profile]
            generation = request["generation"]
            upstream_request: dict[str, Any] = {
                "model": model,
                "input": [
                    {"role": message["role"], "content": [{"type": "input_text", "text": message["text"]}]}
                    for message in request["messages"]
                ],
                "max_output_tokens": max_output_tokens,
                "store": False,
                "background": False,
                "stream": False,
                "service_tier": "default",
                "tools": [],
                "tool_choice": "none",
            }
            # A dated non-reasoning snapshot has no reasoning effort, and emitting a null or zero
            # placeholder for one would be a fabricated pin (spec §1.3). Send exactly one of the two.
            if profile == "reasoning-2026-08":
                upstream_request["reasoning"] = {"effort": generation["reasoningEffort"]}
            else:
                upstream_request["temperature"] = 0
            if self.fake_response is None:
                response = self.client.responses.create(**upstream_request)
                body = response.model_dump(mode="json")
            else:
                body = copy.deepcopy(self.fake_response)
                if body.get("reasoning", {}).get("effort") == "__request__":
                    body["reasoning"]["effort"] = generation["reasoningEffort"]
            try:
                body = Response.model_validate(body).model_dump(mode="json")
            except BaseException:
                return terminal("method-conflict", elapsed=time.monotonic() - started)
            resolved_model = body.get("model")
            usage = body.get("usage")
            output_tokens = usage.get("output_tokens") if isinstance(usage, dict) else None
            if (
                resolved_model != model
                or body.get("status") != "completed"
                or not isinstance(output_tokens, int)
                or output_tokens < 0
                or output_tokens > max_output_tokens
            ):
                return terminal(
                    "method-conflict",
                    resolved_model=resolved_model if isinstance(resolved_model, str) else None,
                    response_id=body.get("id") if isinstance(body.get("id"), str) else None,
                    usage=usage if isinstance(usage, dict) else None,
                    elapsed=time.monotonic() - started,
                )
            return terminal(
                "completed",
                resolved_model=resolved_model,
                response_id=body.get("id") if isinstance(body.get("id"), str) else None,
                usage=usage,
                response_body=body,
                elapsed=time.monotonic() - started,
            )
        except (AuthenticationError, PermissionDeniedError):
            return terminal("authentication-failure", elapsed=time.monotonic() - started)
        except RateLimitError:
            return terminal("rate-limited", elapsed=time.monotonic() - started)
        except APITimeoutError:
            return terminal("timeout", elapsed=time.monotonic() - started)
        except APIStatusError as error:
            return terminal("provider-5xx" if error.status_code >= 500 else "provider-failure", elapsed=time.monotonic() - started)
        except APIConnectionError:
            return terminal("broker-loss", elapsed=time.monotonic() - started)
        finally:
            self.lock.release()


def terminal(
    status: str,
    *,
    detail: str | None = None,
    resolved_model: str | None = None,
    response_id: str | None = None,
    usage: dict[str, Any] | None = None,
    response_body: dict[str, Any] | None = None,
    elapsed: float | None = None,
) -> dict[str, Any]:
    event = {
        "status": status,
        "resolvedModel": resolved_model,
        "responseId": response_id,
        "usage": usage,
        "responseSha256": None if response_body is None else digest(response_body),
    }
    return {
        "protocol": PROTOCOL,
        "status": status,
        "detail": detail,
        "resolvedModel": resolved_model,
        "responseId": response_id,
        "usage": usage,
        "responseBody": response_body,
        "elapsedSeconds": elapsed,
        "eventDigest": digest(event),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "jinn-model-broker/1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def send_json(self, code: int, value: Any) -> None:
        body = canonical_bytes(value)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_json(404, {"ok": False})
            return
        self.send_json(200, {"ok": True, "protocol": PROTOCOL, "models": sorted(ACCEPTED_MODELS)})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/generate-text":
            self.send_json(404, terminal("malformed-request"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_REQUEST_BYTES:
                raise ValueError("request byte budget exceeded")
            decoded = json.loads(self.rfile.read(length))
            request = validate_request(decoded, self.server.state.capability)  # type: ignore[attr-defined]
        except PermissionError:
            self.send_json(403, terminal("capability-rejected"))
            return
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, terminal("malformed-request"))
            return
        self.send_json(200, self.server.state.generate(request))  # type: ignore[attr-defined]


def main() -> int:
    server = ThreadingHTTPServer(("0.0.0.0", 8765), Handler)
    try:
        server.state = BrokerState()  # type: ignore[attr-defined]
    except BaseException as error:
        # Startup errors can carry secret paths or provider internals. Emit only the class for a
        # useful readiness category without reflecting exception text across the boundary.
        code = error.code if isinstance(error, BrokerStartupError) else type(error).__name__
        sys.stderr.write(f"broker-startup:{code}\n")
        return 1
    server.serve_forever(poll_interval=0.1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
