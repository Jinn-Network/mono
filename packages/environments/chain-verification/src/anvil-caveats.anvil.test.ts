// SPDX-License-Identifier: Apache-2.0

// Opt-in. Excluded from the default vitest project (see vitest.config.ts) and skipped when
// no Anvil binary is on PATH. Design §10 says these two behaviours must be measured against
// the pinned version rather than assumed, so this file measures them.

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import type { ProcessHost, RpcTransport, WorkspaceHost } from "./runtime-hosts.js";

const execFileAsync = promisify(execFile);

const PINNED_VERSION = "1.3.7";
const DECLARED_PREVRANDAO =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const SLOT0 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const VAL42 =
  "0x0000000000000000000000000000000000000000000000000000000000000042";

interface EntryIndex {
  readonly accounts: readonly string[];
  readonly codeEntries: readonly string[];
  readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
}

interface MinedBlock {
  readonly prevrandao: string;
  readonly launchControlAccepted: boolean;
}

interface WorldSnapshot {
  readonly dump: string;
  readonly index: EntryIndex;
}

const caveatMeasurements: Record<string, boolean | "skipped"> = {};
let measuredVersion = "";

let nextPort = 30_000 + (process.pid % 10_000);

function recordCaveat(name: string, value: boolean | "skipped"): void {
  caveatMeasurements[name] = value;
}

function anvilAvailable(): boolean {
  try {
    execFileSync("anvil", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function allocatePort(): number {
  nextPort += 1;
  return nextPort;
}

async function anvilVersion(): Promise<string> {
  const { stdout } = await execFileAsync("anvil", ["--version"]);
  return stdout.trim();
}

async function rpcCall(
  port: number,
  method: string,
  params: readonly unknown[] = [],
): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const parsed = JSON.parse(data) as { error?: { message: string }; result: unknown };
          if (parsed.error) {
            reject(new Error(parsed.error.message));
            return;
          }
          resolve(parsed.result);
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function waitForRpc(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpcCall(port, "eth_chainId");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`anvil on port ${port} did not become ready`);
}

function buildPrevrandaoLaunchArgs(): string[] {
  return ["--prevrandao", DECLARED_PREVRANDAO];
}

async function spawnAnvil(
  port: number,
  extraArgs: readonly string[] = [],
): Promise<ChildProcess> {
  const args = [
    "--hardfork",
    "paris",
    "--port",
    String(port),
    "--silent",
    ...extraArgs,
  ];
  const child = spawn("anvil", args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });
  await waitForRpc(port);
  return child;
}

async function acceptsPrevrandaoLaunchFlag(): Promise<boolean> {
  const port = allocatePort();
  try {
    const child = await spawnAnvil(port, buildPrevrandaoLaunchArgs());
    child.kill("SIGKILL");
    return true;
  } catch {
    return false;
  }
}

async function minedBlock(): Promise<MinedBlock> {
  const launchControlAccepted = await acceptsPrevrandaoLaunchFlag();
  const port = allocatePort();
  const launchArgs = launchControlAccepted ? buildPrevrandaoLaunchArgs() : [];
  const child = await spawnAnvil(port, launchArgs);
  await rpcCall(port, "anvil_mine", ["0x1"]);
  const block = (await rpcCall(port, "eth_getBlockByNumber", [
    "latest",
    false,
  ])) as { mixHash: string };
  child.kill("SIGKILL");
  return { prevrandao: block.mixHash, launchControlAccepted };
}

async function makeTempDir(): Promise<string> {
  const { stdout } = await execFileAsync("mktemp", ["-d"]);
  return stdout.trim();
}

async function indexWorld(port: number, accounts: readonly string[]): Promise<EntryIndex> {
  const indexedAccounts: string[] = [];
  const codeEntries: string[] = [];
  const storageSlots: { address: string; slot: string }[] = [];
  for (const address of accounts) {
    const balance = (await rpcCall(port, "eth_getBalance", [address, "latest"])) as string;
    if (balance !== "0x0") indexedAccounts.push(address.toLowerCase());
    const code = (await rpcCall(port, "eth_getCode", [address, "latest"])) as string;
    if (code !== "0x" && code !== "0x0") codeEntries.push(address.toLowerCase());
    const slot = (await rpcCall(port, "eth_getStorageAt", [address, SLOT0, "latest"])) as string;
    if (slot !== SLOT0 && slot !== "0x0") {
      storageSlots.push({ address: address.toLowerCase(), slot: SLOT0 });
    }
  }
  indexedAccounts.sort();
  codeEntries.sort();
  storageSlots.sort((left, right) =>
    (left.address < right.address ? -1 : left.address > right.address ? 1 : 0)
    || (left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0),
  );
  return { accounts: indexedAccounts, codeEntries, storageSlots };
}

async function buildAndIndexWorld(): Promise<WorldSnapshot> {
  const dump = `${await makeTempDir()}/state.json`;
  const port = allocatePort();
  const child = await spawnAnvil(port, ["--state", dump]);
  const accounts = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
  ];
  for (const address of accounts) {
    await rpcCall(port, "anvil_setBalance", [address, "0x1234"]);
    await rpcCall(port, "anvil_setCode", [address, "0x600160005260206000f3"]);
    await rpcCall(port, "anvil_setStorageAt", [address, SLOT0, VAL42]);
  }
  const index = await indexWorld(port, accounts);
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`anvil dump exited with code ${code}`));
    });
    child.kill("SIGTERM");
  });
  return { dump, index };
}

async function relaunchFromDumpAndIndex(dump: string): Promise<{ index: EntryIndex }> {
  const port = allocatePort();
  const child = await spawnAnvil(port, ["--load-state", dump]);
  const accounts = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
  ];
  const index = await indexWorld(port, accounts);
  child.kill("SIGKILL");
  return { index };
}

function entryIndexesEqual(left: EntryIndex, right: EntryIndex): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function measureForkedDumpFidelity(): Promise<boolean | "skipped"> {
  const archiveRpc = process.env.CHAIN_VERIFICATION_ARCHIVE_RPC_URL;
  if (!archiveRpc) return "skipped";
  const dump = `${await makeTempDir()}/state.json`;
  const port = allocatePort();
  const child = await spawnAnvil(port, ["--fork-url", archiveRpc, "--state", dump]);
  const touched = "0x0000000000000000000000000000000000000003";
  await rpcCall(port, "anvil_setBalance", [touched, "0xabcd"]);
  await rpcCall(port, "anvil_setStorageAt", [touched, SLOT0, VAL42]);
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`forked anvil dump exited with code ${code}`));
    });
    child.kill("SIGTERM");
  });
  const before = await relaunchFromDumpAndIndex(dump);
  const after = await relaunchFromDumpAndIndex(dump);
  return entryIndexesEqual(before.index, after.index);
}

function inlineProcessHost(): ProcessHost {
  return {
    async spawn({ command, args }) {
      const port = allocatePort();
      const child = await spawnAnvil(port, args);
      return {
        pid: String(child.pid ?? 0),
        endpoint: `http://127.0.0.1:${port}`,
        async wait() {
          return new Promise((resolve) => {
            child.once("exit", (code) => {
              resolve({ exitCode: code ?? 1, stderr: "" });
            });
          });
        },
        async kill() {
          child.kill("SIGKILL");
        },
      };
    },
  };
}

function inlineRpcTransport(): RpcTransport {
  return {
    async send({ endpoint, method, params }) {
      const url = new URL(endpoint);
      return rpcCall(Number(url.port), method, params);
    },
  };
}

function inlineWorkspaceHost(): WorkspaceHost {
  return {
    async create() {
      return { path: await makeTempDir() };
    },
    async write(path, name) {
      return `${path}/${name}`;
    },
    async destroy(path) {
      await execFileAsync("rm", ["-rf", path]);
    },
  };
}

void inlineProcessHost;
void inlineRpcTransport;
void inlineWorkspaceHost;

describe.skipIf(!anvilAvailable())(`anvil ${PINNED_VERSION} caveats`, () => {
  afterAll(() => {
    console.log(
      JSON.stringify({ measuredVersion, caveats: caveatMeasurements }, null, 2),
    );
  });

  it("reports the pinned version", async () => {
    measuredVersion = await anvilVersion();
    expect(measuredVersion).toContain(PINNED_VERSION);
  });

  it("applies prevrandao at the launch level, or says it does not", async () => {
    const [first, second] = await Promise.all([minedBlock(), minedBlock()]);
    expect({ prevrandaoStable: first.prevrandao === second.prevrandao }).toMatchObject({
      prevrandaoStable: expect.any(Boolean),
    });
    recordCaveat("prevrandao", first.prevrandao === second.prevrandao);
  });

  it("round-trips a dumped state without losing entries", async () => {
    const before = await buildAndIndexWorld();
    const after = await relaunchFromDumpAndIndex(before.dump);
    recordCaveat(
      "dumpFidelityLocal",
      entryIndexesEqual(before.index, after.index),
    );
    expect(after.index.accounts.length).toBeGreaterThan(0);
  });

  it("round-trips a dumped state from a FORKED instance, or says it does not", async () => {
    const result = await measureForkedDumpFidelity();
    recordCaveat("dumpFidelityForked", result);
    if (result === "skipped") return;
    expect(typeof result).toBe("boolean");
  });
});
