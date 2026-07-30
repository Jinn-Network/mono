// Two runs of `describeMarketplaceBackendConformance` (design §13):
//
// 1. A stub-chain run (this file, always on -- no network dependency) that exercises the exact
//    same suite against `makeMarketplaceBackend` wired to in-memory ports, so the suite's own
//    logic is proven fast and hermetically before spending an Anvil fork on it.
// 2. The Anvil-fork run (§13 "local fork" -- forks Base Sepolia and posts against the REAL
//    deployed JinnRouterV3), which additionally proves the chain-venue wiring itself. Skips
//    cleanly when no RPC is reachable (mirrors `client/scripts/e2e-validate.ts`'s own skip
//    discipline) or when `anvil` (Foundry) is not on PATH.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryMarketplaceObserveStore,
  createInMemoryPostingIntentStore,
  encodeCreateTaskCalldata,
  makeMarketplaceBackend,
  type MarketplaceBackendPorts,
  type PostingTerms,
} from "@jinn-network/marketplace-binding";
import type { TestableBackend } from "@jinn-network/task-execution-testing";
import { afterAll, beforeAll, describe } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describeMarketplaceBackendConformance } from "./backend-conformance.js";

const TERMS: PostingTerms = {
  solutionMaxDeliveryRateWei: 10n,
  verdictMaxDeliveryRateWei: 5n,
  responseTimeoutSeconds: 3600n,
  allowSolverSelfEvaluation: false,
};

function makeStubbedBackend(): TestableBackend {
  let nextTaskId = 1n;
  const ports: MarketplaceBackendPorts = {
    creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
    terms: TERMS,
    posting: {
      ipfs: { pin: async () => {} },
      intents: createInMemoryPostingIntentStore(),
      safe: {
        broadcastCreateTask: async () => {
          const taskId = nextTaskId;
          nextTaskId += 1n;
          return { taskId, txHash: `0x${taskId.toString(16).padStart(64, "0")}` as `0x${string}` };
        },
      },
    },
    observe: createInMemoryMarketplaceObserveStore(BASE_SEPOLIA_TODAY),
  };
  // `makeMarketplaceBackend` returns `MarketplaceTestableBackend`, which is structurally
  // identical to `@jinn-network/task-execution-testing`'s `TestableBackend` seam (ruling §7.19) --
  // no cast needed beyond the return-type widening TypeScript performs automatically here.
  return makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);
}

describe("marketplace backend conformance -- stub-chain (hermetic)", () => {
  describeMarketplaceBackendConformance(makeStubbedBackend);
});

// ---------------------------------------------------------------------------
// Anvil-fork run
// ---------------------------------------------------------------------------

const FORK_RPC_CANDIDATES = [
  process.env["JINN_MARKETPLACE_FORK_RPC_URL"],
  "https://base-sepolia.publicnode.com",
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
].filter((url): url is string => typeof url === "string" && url.trim().length > 0);

let FORK_RPC_URL = FORK_RPC_CANDIDATES[0] ?? "https://base-sepolia.publicnode.com";
// A per-process port prevents an interrupted local run from sharing a fork (and account nonce
// state) with the next run. CI may pin a port when its runner policy requires one.
const ANVIL_PORT = Number(process.env["JINN_MARKETPLACE_ANVIL_PORT"] ?? 8600 + (process.pid % 1000));
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
// Anvil's default well-known dev account #0 -- funded with 10000 ETH on every fresh fork.
const DEV_PRIVATE_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

async function isReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/** Publicnode intermittently 403s archive eth_getStorageAt; probe before committing the fork URL. */
async function supportsArchiveReads(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getStorageAt",
        params: ["0x0000000000000000000000000000000000000001", "0x0", "0x1"],
        id: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return false;
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error?.message?.toLowerCase().includes("archive")) return false;
    return typeof body.result === "string";
  } catch {
    return false;
  }
}

async function anvilAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn("anvil", ["--version"]);
    probe.on("error", () => resolve(false));
    probe.on("exit", (code) => resolve(code === 0));
  });
}

let anvilProcess: ChildProcessWithoutNullStreams | undefined;
let forkTransactionQueue = Promise.resolve();

async function serializeForkTransaction<T>(work: () => Promise<T>): Promise<T> {
  const previous = forkTransactionQueue;
  let release: (() => void) | undefined;
  forkTransactionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release?.();
  }
}

async function startAnvilFork(): Promise<boolean> {
  const hasAnvil = await anvilAvailable();
  if (!hasAnvil) return false;

  for (const candidate of FORK_RPC_CANDIDATES) {
    if (!(await isReachable(candidate))) continue;
    // Prefer archive-capable endpoints; still try non-archive as last resort within the list.
    const archiveOk = await supportsArchiveReads(candidate);
    if (!archiveOk && candidate !== FORK_RPC_CANDIDATES[FORK_RPC_CANDIDATES.length - 1]) continue;

    FORK_RPC_URL = candidate;
    anvilProcess = spawn("anvil", ["--fork-url", FORK_RPC_URL, "--port", String(ANVIL_PORT), "--silent"]);
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      const check = setInterval(() => {
        isReachable(ANVIL_URL).then((up) => {
          if (up) {
            clearInterval(check);
            clearTimeout(timer);
            resolve(true);
          }
        }).catch(() => {});
      }, 500);
    });
    if (ready) return true;
    stopAnvilFork();
  }
  return false;
}

function stopAnvilFork(): void {
  anvilProcess?.kill();
  anvilProcess = undefined;
}

const TASK_CREATED_EVENT = parseAbi([
  "event TaskCreated(address indexed creator, uint256 indexed taskId, bytes32 indexed manifestDigest, bytes32 taskCidDigest, uint32 maxClaims, uint256 solutionBudget, uint256 verdictBudget)",
])[0];

function makeForkBackedBackend(): TestableBackend {
  const account = privateKeyToAccount(DEV_PRIVATE_KEY);
  const transport = http(ANVIL_URL, {
    retryCount: 2,
    retryDelay: 250,
    timeout: 30_000,
  });
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });

  const ports: MarketplaceBackendPorts = {
    creatorSafe: account.address as Address,
    terms: TERMS,
    posting: {
      ipfs: { pin: async () => {} },
      intents: createInMemoryPostingIntentStore(),
      safe: {
        // Direct EOA call (documented simplification, not Safe-routed): `JinnRouterV3.createTask`
        // is a plain `payable` function keyed on `msg.sender`, not Safe-gated -- Safe-routing
        // itself (venue/safe.ts) is separately unit-tested and is an orthogonal "how the tx
        // reaches the chain" concern the pipeline (Milestone M6) will wire for real. `postTask`
        // (posting.ts) already built exact calldata via `encodeCreateTaskCalldata`, so this port
        // just broadcasts it as a raw transaction and decodes `TaskCreated` off the receipt.
        broadcastCreateTask: async (input) => serializeForkTransaction(async () => {
          const hash = await walletClient.sendTransaction({
            to: input.to,
            data: input.data,
            value: input.value,
            account,
            chain: null,
            // Every conformance case gets a fresh backend/wallet client. Explicitly allocate the
            // nonce while holding the fork-wide queue so a new client cannot reuse a stale one.
            nonce: await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
          });
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            pollingInterval: 250,
            timeout: 60_000,
          });
          if (receipt.status !== "success") throw new Error(`createTask reverted (tx=${hash})`);
          const created = receipt.logs
            .map((log) => {
              try {
                return decodeEventLog({ abi: [TASK_CREATED_EVENT], data: log.data, topics: log.topics });
              } catch {
                return undefined;
              }
            })
            .find((event) => event !== undefined);
          if (created === undefined) throw new Error(`TaskCreated not found in receipt logs (tx=${hash})`);
          return { taskId: created.args.taskId, txHash: hash };
        }),
      },
    },
    observe: createInMemoryMarketplaceObserveStore(BASE_SEPOLIA_TODAY),
  };
  return makeMarketplaceBackend(BASE_SEPOLIA_TODAY, ports);
}

describe.runIf(await startAnvilFork())(
  "marketplace backend conformance -- Anvil fork of Base Sepolia (§13)",
  { timeout: 60_000 },
  () => {
    afterAll(() => {
      stopAnvilFork();
    });

    describeMarketplaceBackendConformance(makeForkBackedBackend);
  },
);
