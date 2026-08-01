"""A minimal MCP-shaped stdio server for the client tests.

Run as ``python3 fake_server.py <mode>``. Modes exercise the branches the
client must survive: normal, an unsupported protocol reply, a tool error, a
slow call, a crash at start, and a chatty stderr.
"""

from __future__ import annotations

import json
import sys
import time


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
    if mode == "crash":
        sys.stderr.write("fake server refuses to start\n")
        return 3
    if mode == "chatty":
        for index in range(5000):
            sys.stderr.write(f"noise line {index}\n")
        sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        method = request.get("method")
        if method == "initialize":
            version = "1999-01-01" if mode == "bad-protocol" else request["params"]["protocolVersion"]
            send({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "jinn", "version": "0.0.0-fake"},
                },
            })
        elif method == "notifications/initialized":
            continue
        elif method == "tools/call":
            if mode == "slow":
                time.sleep(5)
            name = request["params"]["name"]
            if mode == "tool-error":
                send({
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": {
                        "content": [{"type": "text", "text": json.dumps({"error": {"code": "NO_LOCATION", "retryable": True}})}],
                        "isError": True,
                    },
                })
            elif mode == "protocol-error":
                send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": f"unknown tool {name}"}})
            else:
                send({
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": {"content": [{"type": "text", "text": json.dumps({"echo": request["params"].get("arguments", {})})}]},
                })
        else:
            send({"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32601, "message": "no"}})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
