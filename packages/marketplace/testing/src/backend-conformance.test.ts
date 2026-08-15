// Two runs of `describeMarketplaceBackendConformance` (design §13):
//
// 1. A stub-chain run (this file, always on -- no network dependency) that exercises the exact
//    same suite against `makeMarketplaceBackend` wired to in-memory ports, so the suite's own
//    logic is proven fast before spending a snapshot-backed Anvil process on it.
// 2. The snapshot-backed Anvil run (§13 "local fork" compatibility name), which deploys and posts
//    against a real JinnRouterV3 without any live RPC dependency. It skips only when `anvil`
//    (Foundry) is not on PATH.
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryMarketplaceObserveStore,
  createInMemoryPostingIntentStore,
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
import { anvilAvailable } from "./anvil-state.js";
import {
  startForkVenue,
  type ForkVenueDeployment,
  type ForkVenueSession,
} from "./venue-fork.js";

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
// Snapshot-backed Anvil run
// ---------------------------------------------------------------------------

// Anvil's default well-known dev account #0 -- funded in the committed state fixture.
const DEV_PRIVATE_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
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

const TASK_CREATED_EVENT = parseAbi([
  "event TaskCreated(address indexed creator, uint256 indexed taskId, bytes32 indexed manifestDigest, bytes32 taskCidDigest, uint32 maxClaims, uint256 solutionBudget, uint256 verdictBudget)",
])[0];

let forkVenue: ForkVenueDeployment | undefined;

function makeForkBackedBackend(): TestableBackend {
  if (forkVenue === undefined) throw new Error("snapshot-backed venue was not started");
  const account = privateKeyToAccount(DEV_PRIVATE_KEY);
  const transport = http(forkVenue.rpcUrl, {
    retryCount: 0,
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
    observe: createInMemoryMarketplaceObserveStore(forkVenue.chain),
  };
  return makeMarketplaceBackend(forkVenue.chain, ports);
}

const hasAnvil = await anvilAvailable();

describe.runIf(hasAnvil)(
  "marketplace backend conformance -- committed Anvil state (§13)",
  { timeout: 60_000 },
  () => {
    let session: ForkVenueSession | undefined;

    beforeAll(async () => {
      session = await startForkVenue("today");
      forkVenue = session.deployment;
      forkTransactionQueue = Promise.resolve();
    }, 90_000);

    afterAll(async () => {
      forkVenue = undefined;
      await session?.close();
    });

    describeMarketplaceBackendConformance(makeForkBackedBackend);
  },
);
