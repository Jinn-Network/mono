// SPDX-License-Identifier: Apache-2.0
/**
 * Live Anvil ProcessHost helpers for the chain-only gate (F-GATE-2).
 *
 * Sealed (blackhole) materializations spawn a fresh Anvil, load the harvested
 * state artifact via anvil_set*, then read the same keys the connected baseline
 * read — so K≥5 blackhole runs hit a real simulator, not a fake trie world.
 */

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function jsonRpc(endpoint, method, params = [], signal) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "jinn-chain-only-gate/0.1",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status} for ${method}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC ${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

/**
 * @returns {import('@jinn-network/chain-environment-verification').ProcessHost}
 */
export function createNodeProcessHost() {
  return {
    async spawn({ command, args, cwd, env, signal }) {
      const port = await allocatePort();
      const endpoint = `http://127.0.0.1:${port}`;
      const launchArgs = [...args];
      if (!launchArgs.includes("--port")) {
        launchArgs.push("--port", String(port));
      }
      if (!launchArgs.includes("--silent")) {
        launchArgs.push("--silent");
      }

      let stderrTail = "";
      const child = spawn(command, launchArgs, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "ignore", "pipe"],
        detached: false,
        signal,
      });
      child.stderr?.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2048);
      });

      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(
            `anvil exited before ready (code=${child.exitCode}): ${stderrTail.trim()}`,
          );
        }
        try {
          await jsonRpc(endpoint, "eth_chainId");
          ready = true;
          break;
        } catch {
          await sleep(100);
        }
      }
      if (!ready) {
        child.kill("SIGKILL");
        throw new Error(`anvil did not become ready: ${stderrTail.trim()}`);
      }

      return {
        pid: String(child.pid ?? 0),
        endpoint,
        async wait() {
          return new Promise((resolve) => {
            child.once("exit", (code) => {
              resolve({ exitCode: code ?? 1, stderr: stderrTail });
            });
          });
        },
        async kill() {
          if (child.exitCode === null) child.kill("SIGKILL");
        },
      };
    },
  };
}

/**
 * @returns {import('@jinn-network/chain-environment-verification').RpcTransport}
 */
export function createFetchRpcTransport() {
  return {
    async send({ endpoint, method, params, signal }) {
      return jsonRpc(endpoint, method, params, signal);
    },
  };
}

/**
 * @returns {import('@jinn-network/chain-environment-verification').WorkspaceHost}
 */
export function createTempWorkspaceHost() {
  return {
    async create(instanceId) {
      const path = await mkdtemp(join(tmpdir(), `jinn-gate-${instanceId.replace(/[/:]/g, "-")}-`));
      return { path };
    },
    async write(path, name, bytes) {
      const file = join(path, name.replace(/[/:]/g, "_"));
      await writeFile(file, bytes);
      return file;
    },
    async destroy(path) {
      await rm(path, { recursive: true, force: true });
    },
  };
}

function normalizeHex(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`expected 0x-hex, got ${String(value)}`);
  }
  return value.toLowerCase();
}

function padWord(value) {
  const body = normalizeHex(value).slice(2);
  return `0x${body.padStart(64, "0").slice(-64)}`;
}

/**
 * Load a CE4 state artifact into a running Anvil via anvil_set* RPCs.
 * @param {string} endpoint
 * @param {{ accounts: readonly {
 *   address: string, balance: string, nonce: string, code?: string,
 *   storage: readonly { slot: string, value: string }[]
 * }[] }} artifact
 */
export async function loadStateArtifactIntoAnvil(endpoint, artifact) {
  for (const account of artifact.accounts) {
    const address = normalizeHex(account.address);
    await jsonRpc(endpoint, "anvil_setBalance", [address, normalizeHex(account.balance)]);
    await jsonRpc(endpoint, "anvil_setNonce", [address, normalizeHex(account.nonce)]);
    if (account.code !== undefined && account.code !== "0x" && account.code !== "0x0") {
      await jsonRpc(endpoint, "anvil_setCode", [address, normalizeHex(account.code)]);
    }
    for (const entry of account.storage) {
      await jsonRpc(endpoint, "anvil_setStorageAt", [
        address,
        padWord(entry.slot),
        padWord(entry.value),
      ]);
    }
  }
}

/**
 * Read account/code/slots from a live Anvil endpoint (same key shape as gate-runtime).
 */
export async function readSourceFromAnvil(endpoint, source, slots, log) {
  const address = normalizeHex(source);
  const zero = `0x${"0".repeat(64)}`;
  const nonce = await jsonRpc(endpoint, "eth_getTransactionCount", [address, "latest"]);
  const nonceBody = normalizeHex(nonce).slice(2).replace(/^0+/, "");
  log.push({
    key: `account:${address}`,
    value: `0x${nonceBody.length === 0 ? "0" : nonceBody}`,
  });
  const code = await jsonRpc(endpoint, "eth_getCode", [address, "latest"]);
  log.push({ key: `code:${address}`, value: normalizeHex(code === "0x0" ? "0x" : code) });
  for (const slot of slots) {
    const value = await jsonRpc(endpoint, "eth_getStorageAt", [address, padWord(slot), "latest"]);
    log.push({ key: `slot:${address}:${padWord(slot)}`, value: padWord(value ?? zero) });
  }
}
