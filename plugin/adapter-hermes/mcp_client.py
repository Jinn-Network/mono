"""A standard-library MCP client over stdio.

Why not the ``mcp`` package: it is an optional Hermes extra
(``hermes-agent[mcp]``), and ``hermes plugins install`` clones a plugin without
running any dependency install. Importing it would make capture and retrieval
conditional on an extra the operator may not have. MCP over stdio is
newline-delimited JSON-RPC 2.0, and the adapter needs three messages, so the
client is written here and stays small on purpose.

Every wait is bounded. A reader thread feeds a queue so no call can block
forever on a wedged child, and stderr is drained into a bounded ring so a chatty
runtime can never fill a pipe and deadlock the host session.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from collections import deque
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence, Tuple

CLIENT_NAME = "jinn-hermes-adapter"
CLIENT_VERSION = "0.1.0"

# Requested at initialize. The server negotiates down when it prefers another
# revision, so this is a preference, not a requirement.
PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_PROTOCOL_VERSIONS = (
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
)

STDERR_RING_LINES = 50
DEFAULT_TIMEOUT_S = 30.0
_TERMINATE_GRACE_S = 2.0


class McpClientError(RuntimeError):
    """A transport, handshake, or protocol failure."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


class McpToolError(McpClientError):
    """The tool answered with ``isError`` and a structured payload."""

    def __init__(self, tool: str, payload: Dict[str, Any]) -> None:
        error = payload.get("error") if isinstance(payload, dict) else None
        code = str(error.get("code")) if isinstance(error, dict) and error.get("code") else "tool-error"
        detail = str(error.get("detail")) if isinstance(error, dict) and error.get("detail") else tool
        super().__init__(code, detail)
        self.tool = tool
        self.payload = payload


class McpClient:
    """One runtime subprocess, one JSON-RPC session."""

    def __init__(
        self,
        argv: Sequence[str],
        env: Mapping[str, str],
        cwd: Optional[Path] = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self._argv = tuple(argv)
        self._env = dict(env)
        self._cwd = cwd
        self._timeout_s = timeout_s
        self._process: Optional[subprocess.Popen] = None
        self._inbox: "Queue[str]" = Queue()
        self._stderr: "deque[str]" = deque(maxlen=STDERR_RING_LINES)
        self._next_id = 0
        self._lock = threading.Lock()
        self.protocol_version = ""
        self.server_info: Dict[str, Any] = {}

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> "McpClient":
        if self._process is not None:
            return self
        environment = {**os.environ, **self._env}
        try:
            self._process = subprocess.Popen(
                list(self._argv),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
                env=environment,
                cwd=str(self._cwd) if self._cwd else None,
            )
        except OSError as exc:
            raise McpClientError("start-failed", str(exc)) from exc
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()
        try:
            self._handshake()
        except McpClientError:
            self.close()
            raise
        return self

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=_TERMINATE_GRACE_S)
            except subprocess.TimeoutExpired:
                process.kill()
        self._returncode = process.returncode

    def __enter__(self) -> "McpClient":
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.close()

    @property
    def returncode(self) -> Optional[int]:
        return getattr(self, "_returncode", None)

    def recent_stderr(self) -> Tuple[str, ...]:
        return tuple(self._stderr)

    # -- calls -------------------------------------------------------------

    def call_tool(self, name: str, arguments: Mapping[str, Any]) -> Dict[str, Any]:
        """Call a tool and return the parsed payload of its single text block."""
        result = self._request("tools/call", {"name": name, "arguments": dict(arguments)})
        payload = _payload_of(result)
        if result.get("isError"):
            raise McpToolError(name, payload)
        return payload

    # -- internals ---------------------------------------------------------

    def _handshake(self) -> None:
        result = self._request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": CLIENT_VERSION},
            },
        )
        version = str(result.get("protocolVersion") or "")
        if version not in SUPPORTED_PROTOCOL_VERSIONS:
            raise McpClientError(
                "protocol-unsupported",
                f"server negotiated protocol {version!r}, which this adapter does not speak",
            )
        self.protocol_version = version
        info = result.get("serverInfo")
        self.server_info = info if isinstance(info, dict) else {}
        self._notify("notifications/initialized", {})

    def _request(self, method: str, params: Mapping[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
        self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)})
        message = self._await_response(request_id)
        if "error" in message:
            error = message["error"] or {}
            raise McpClientError("rpc-error", f"{error.get('code')}: {error.get('message')}")
        result = message.get("result")
        return result if isinstance(result, dict) else {}

    def _notify(self, method: str, params: Mapping[str, Any]) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": dict(params)})

    def _write(self, message: Mapping[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise McpClientError("not-running", "the runtime process is not running")
        try:
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()
        except (BrokenPipeError, ValueError, OSError) as exc:
            raise McpClientError("transport-closed", self._exit_detail(str(exc))) from exc

    def _await_response(self, request_id: int) -> Dict[str, Any]:
        deadline_queue: Iterable[int] = range(1)  # readability: one logical wait
        del deadline_queue
        remaining = self._timeout_s
        while remaining > 0:
            step = min(remaining, 0.25)
            try:
                line = self._inbox.get(timeout=step)
            except Empty:
                process = self._process
                if process is not None and process.poll() is not None:
                    raise McpClientError("start-failed", self._exit_detail("the runtime exited"))
                remaining -= step
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue  # a non-JSON line on stdout is not ours; ignore it
            if isinstance(message, dict) and message.get("id") == request_id:
                return message
        raise McpClientError("timeout", f"no response within {self._timeout_s:g}s")

    def _exit_detail(self, prefix: str) -> str:
        tail = " | ".join(line.strip() for line in list(self._stderr)[-3:] if line.strip())
        return f"{prefix}{': ' + tail if tail else ''}"

    def _pump_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            for line in process.stdout:
                self._inbox.put(line)
        except (ValueError, OSError):
            pass

    def _pump_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            for line in process.stderr:
                self._stderr.append(line.rstrip("\n"))
        except (ValueError, OSError):
            pass


def _payload_of(result: Mapping[str, Any]) -> Dict[str, Any]:
    """Every tool in this runtime answers with exactly one text block."""
    content = result.get("content")
    if not isinstance(content, list) or not content:
        return {}
    first = content[0]
    if not isinstance(first, dict) or first.get("type") != "text":
        return {}
    try:
        parsed = json.loads(str(first.get("text") or ""))
    except json.JSONDecodeError:
        return {"text": str(first.get("text") or "")}
    return parsed if isinstance(parsed, dict) else {"value": parsed}


def spawn_session_client(resolution, home: Path, timeout_s: float = DEFAULT_TIMEOUT_S) -> McpClient:
    """The adapter-spawned, session-role instance (the second MCP client)."""
    return McpClient(
        argv=(*resolution.argv, "serve", "--role", "session"),
        env={"JINN_PLUGIN_HOME": str(home)},
        timeout_s=timeout_s,
    )
