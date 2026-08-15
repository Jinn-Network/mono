// SPDX-License-Identifier: Apache-2.0
/** Host-side Anvil fork spawn for the chain-only gate (free local archive). */

import { createServer } from "node:net";
import { spawn } from "node:child_process";

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function jsonRpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "jinn-chain-only-gate/0.1",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status} for ${method}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC ${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn `anvil --fork-url <upstream>` on a free local port.
 * Anvil holds the forked tip, so eth_getProof against the frozen capture block keeps working.
 *
 * @param {{ forkUrl: string, forkBlock?: number, readyTimeoutMs?: number, silent?: boolean }} opts
 */
export async function spawnAnvilFork(opts) {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const silent = opts.silent ?? true;
  const port = await allocatePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const args = ["--fork-url", opts.forkUrl, "--port", String(port), "--chain-id", "84532"];
  if (opts.forkBlock !== undefined) {
    args.push("--fork-block-number", String(opts.forkBlock));
  }
  if (silent) args.push("--silent");

  let stderrTail = "";
  const child = spawn("anvil", args, {
    stdio: silent ? ["ignore", "ignore", "pipe"] : "inherit",
    detached: false,
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2048);
  });

  const exitPromise = new Promise((_, reject) => {
    child.once("error", (err) => reject(new Error(`anvil failed to spawn: ${err.message}`)));
    child.once("exit", (code, signal) => {
      const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
      reject(new Error(`anvil exited before ready (code=${code}, signal=${signal})${detail}`));
    });
  });

  const readyPromise = (async () => {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await jsonRpc(rpcUrl, "eth_chainId", []);
        return;
      } catch {
        await sleep(150);
      }
    }
    throw new Error(`anvil not ready within ${readyTimeoutMs}ms on port ${port}`);
  })();

  try {
    await Promise.race([readyPromise, exitPromise]);
  } catch (err) {
    if (!child.killed) child.kill("SIGKILL");
    throw err;
  }

  return {
    rpcUrl,
    port,
    pid: child.pid ?? -1,
    async teardown() {
      if (child.killed) return;
      child.kill("SIGKILL");
    },
  };
}
