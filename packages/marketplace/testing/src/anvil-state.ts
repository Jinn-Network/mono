// SPDX-License-Identifier: MIT

import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";

const BASE_SEPOLIA_CHAIN_ID = 84532;
const DEFAULT_STATE_PATH = fileURLToPath(
  new URL("../../../../client/test/_support/fixtures/anvil-base-v3-state/state.json", import.meta.url),
);

export interface SnapshotAnvil {
  readonly rpcUrl: string;
  readonly statePath: string;
  stop(): Promise<void>;
}

/** True when `anvil` resolves on PATH and answers `--version`. */
export async function anvilAvailable(): Promise<boolean> {
  return new Promise((complete) => {
    const probe = spawn("anvil", ["--version"], { stdio: "ignore" });
    probe.once("error", () => complete(false));
    probe.once("exit", (code) => complete(code === 0));
  });
}

/**
 * Resolve the committed state used by PR verification. The environment override exists for
 * source-tree consumers that place the same committed fixture at another absolute path; it is
 * deliberately not a URL and there is no live-chain fallback.
 */
export function resolveAnvilStatePath(
  configured = process.env["JINN_MARKETPLACE_ANVIL_STATE_PATH"],
): string {
  return resolve(configured?.trim() || DEFAULT_STATE_PATH);
}

async function allocatePort(): Promise<number> {
  return new Promise((complete, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not resolve OS-assigned Anvil port"));
        return;
      }
      server.close(() => complete(address.port));
    });
  });
}

interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: Error;
}

function childExit(child: ChildProcess): Promise<ExitResult> {
  return new Promise((complete) => {
    child.once("error", (spawnError) => complete({ code: null, signal: null, spawnError }));
    child.once("exit", (code, signal) => complete({ code, signal }));
  });
}

async function terminate(child: ChildProcess, exited: Promise<ExitResult>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((complete) => setTimeout(() => complete(false), 5_000)),
  ]);
  if (graceful) return;

  child.kill("SIGKILL");
  const killed = await Promise.race([
    exited.then(() => true),
    new Promise<false>((complete) => setTimeout(() => complete(false), 5_000)),
  ]);
  if (!killed) throw new Error(`Anvil process ${child.pid ?? "unknown"} did not terminate`);
}

/** Start an isolated Anvil from the repository's committed Base state, without network egress. */
export async function startSnapshotAnvil(options: {
  readonly statePath?: string;
  readonly readyTimeoutMs?: number;
} = {}): Promise<SnapshotAnvil> {
  const statePath = resolveAnvilStatePath(options.statePath);
  let metadata;
  try {
    metadata = await stat(statePath);
  } catch (error) {
    throw new Error(`committed Anvil state is unavailable at ${statePath}`, { cause: error });
  }
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`committed Anvil state must be a non-empty regular file: ${statePath}`);
  }

  const port = await allocatePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    "anvil",
    [
      "--load-state",
      statePath,
      "--chain-id",
      String(BASE_SEPOLIA_CHAIN_ID),
      // A dump contains state and its head, not the preceding block history. Anvil's default
      // 32-slot epoch therefore points `finalized` at an absent historical header. A one-slot
      // local epoch keeps safe/finalized tags on blocks mined during this isolated test process.
      "--slots-in-an-epoch",
      "1",
      "--port",
      String(port),
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = childExit(child);
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4_096);
  });

  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 500 }) });
  const ready = (async (): Promise<"ready"> => {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const chainId = await client.getChainId();
        if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
          throw new Error(`loaded Anvil state reported chain id ${chainId}`);
        }
        return "ready";
      } catch {
        await new Promise((complete) => setTimeout(complete, 100));
      }
    }
    throw new Error(`Anvil did not become ready within ${readyTimeoutMs}ms on port ${port}`);
  })();

  try {
    const outcome = await Promise.race([ready, exited]);
    if (outcome !== "ready") {
      const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
      if (outcome.spawnError !== undefined) {
        throw new Error(`Anvil failed to spawn: ${outcome.spawnError.message}${detail}`);
      }
      throw new Error(
        `Anvil exited before becoming ready (code=${outcome.code}, signal=${outcome.signal})${detail}`,
      );
    }
  } catch (error) {
    await terminate(child, exited);
    throw error;
  }

  let stopped = false;
  return {
    rpcUrl,
    statePath,
    async stop() {
      if (stopped) return;
      stopped = true;
      await terminate(child, exited);
    },
  };
}
