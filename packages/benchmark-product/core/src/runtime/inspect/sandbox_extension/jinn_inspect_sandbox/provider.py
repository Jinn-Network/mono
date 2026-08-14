"""Inspect SandboxEnvironment backed by the trusted Benchmark Product host.

The provider never talks to Docker. It sends a narrow request over the worker's
private stdio control channel; the Tier 4 host owns all container lifecycle and
policy decisions.
"""

from __future__ import annotations

import base64
import json
import sys
import threading
from typing import Any, Literal

import anyio
from inspect_ai.util import ExecResult, SandboxEnvironment, sandboxenv
from pydantic import BaseModel, ConfigDict, Field
from typing_extensions import override


PROTOCOL = "jinn.network/inspect-sandbox-host/1"


class JinnOciSandboxConfig(BaseModel):
    model_config = ConfigDict(frozen=True, populate_by_name=True, serialize_by_alias=True)

    schema_: Literal["jinn.network/benchmark-product/inspect-sandbox/1"] = Field(
        alias="schema",
        serialization_alias="schema",
    )
    imageDigest: str
    platform: Literal["linux/amd64"]
    policySha256: str


class _Transport:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sequence = 0

    def _call_sync(self, operation: str, params: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._sequence += 1
            request_id = str(self._sequence)
            request = {
                "channel": "sandbox",
                "protocol": PROTOCOL,
                "id": request_id,
                "operation": operation,
                "params": params,
            }
            payload = json.dumps(request, sort_keys=True, separators=(",", ":"))
            sys.__stdout__.buffer.write(payload.encode("utf-8") + b"\n")
            sys.__stdout__.buffer.flush()
            line = sys.__stdin__.buffer.readline()
            if not line:
                raise RuntimeError("Inspect sandbox host disconnected")
            try:
                response = json.loads(line)
            except Exception as cause:
                raise RuntimeError("Inspect sandbox host returned malformed JSON") from cause
            if (
                not isinstance(response, dict)
                or response.get("channel") != "sandbox-response"
                or response.get("protocol") != PROTOCOL
                or response.get("id") != request_id
                or not isinstance(response.get("ok"), bool)
            ):
                raise RuntimeError("Inspect sandbox host returned an invalid response")
            if not response["ok"]:
                kind = response.get("error", {}).get("kind")
                if kind == "timeout":
                    raise TimeoutError("sandbox operation timed out")
                if kind == "permission":
                    raise PermissionError("sandbox operation was refused")
                if kind == "not-found":
                    raise FileNotFoundError("sandbox path was not found")
                if kind == "is-directory":
                    raise IsADirectoryError("sandbox path is a directory")
                raise RuntimeError("Inspect sandbox host refused the operation")
            value = response.get("value")
            if not isinstance(value, dict):
                raise RuntimeError("Inspect sandbox host returned an invalid value")
            return value

    async def call(self, operation: str, params: dict[str, Any]) -> dict[str, Any]:
        return await anyio.to_thread.run_sync(self._call_sync, operation, params)


_transport = _Transport()


@sandboxenv(name="jinn-oci")
class JinnOciSandboxEnvironment(SandboxEnvironment):
    def __init__(self, environment_id: str, working_dir: str) -> None:
        super().__init__()
        self._environment_id = environment_id
        self._working_dir = working_dir

    @classmethod
    def default_concurrency(cls) -> int | None:
        return 1

    @classmethod
    def config_deserialize(cls, config: dict[str, Any]) -> BaseModel:
        return JinnOciSandboxConfig.model_validate(config)

    @classmethod
    async def sample_init(
        cls,
        task_name: str,
        config: BaseModel | str | None,
        metadata: dict[str, str],
    ) -> dict[str, SandboxEnvironment]:
        if not isinstance(config, JinnOciSandboxConfig):
            raise TypeError("jinn-oci requires the sealed Jinn sandbox configuration")
        value = await _transport.call("startSample", {
            "taskName": task_name,
            "sampleId": str(metadata.get("__sample_id__", "")),
            "config": config.model_dump(mode="json", by_alias=True),
        })
        environment_id = value.get("environmentId")
        working_dir = value.get("workingDir")
        if not isinstance(environment_id, str) or not isinstance(working_dir, str):
            raise RuntimeError("Inspect sandbox host returned an invalid environment")
        return {"default": cls(environment_id, working_dir)}

    @classmethod
    async def sample_cleanup(
        cls,
        task_name: str,
        config: BaseModel | str | None,
        environments: dict[str, SandboxEnvironment],
        interrupted: bool,
    ) -> None:
        for environment in environments.values():
            if isinstance(environment, cls):
                await _transport.call("finishSample", {
                    "environmentId": environment._environment_id,
                    "interrupted": interrupted,
                })

    @override
    async def exec(
        self,
        cmd: list[str],
        input: str | bytes | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        user: str | None = None,
        timeout: int | None = None,
        timeout_retry: bool = True,
        concurrency: bool = True,
    ) -> ExecResult[str]:
        del timeout_retry, concurrency
        encoded_input = None
        if input is not None:
            raw = input.encode("utf-8") if isinstance(input, str) else input
            encoded_input = base64.b64encode(raw).decode("ascii")
        value = await _transport.call("exec", {
            "environmentId": self._environment_id,
            "cmd": cmd,
            "inputBase64": encoded_input,
            "cwd": cwd,
            "env": env or {},
            "user": user,
            "timeoutSeconds": timeout,
        })
        return ExecResult(
            bool(value.get("returncode") == 0),
            int(value.get("returncode", 1)),
            str(value.get("stdout", "")),
            str(value.get("stderr", "")),
        )

    @override
    async def write_file(self, file: str, contents: str | bytes) -> None:
        raw = contents.encode("utf-8") if isinstance(contents, str) else contents
        await _transport.call("writeFile", {
            "environmentId": self._environment_id,
            "path": file,
            "contentsBase64": base64.b64encode(raw).decode("ascii"),
        })

    @override
    async def read_file(self, file: str, text: bool = True) -> str | bytes:
        value = await _transport.call("readFile", {
            "environmentId": self._environment_id,
            "path": file,
        })
        encoded = value.get("contentsBase64")
        if not isinstance(encoded, str):
            raise RuntimeError("Inspect sandbox host returned invalid file contents")
        raw = base64.b64decode(encoded, validate=True)
        return raw.decode("utf-8") if text else raw
