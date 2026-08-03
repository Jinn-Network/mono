// SPDX-License-Identifier: MIT

// The Anvil-fork integration backbone (design §6.6). Spins up a throwaway `anvil --fork-url`
// against Base Sepolia, deploys the today-generation TaskCoordinator + JinnRouterV3 + marketplace
// mocks this tree's proven fixtures already exercise (`escrow-lifecycle.test.ts`), and hands the
// deployment to a caller-supplied `run`. The well-known Anvil dev key is the one private-key
// literal this plan allows anywhere in this component -- it lives here, in `marketplace-testing`,
// and must never appear in `@jinn-network/marketplace-venue-base`.
import { randomBytes } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import {
  JINN_ROUTER_V3_ABI,
  TASK_COORDINATOR_ABI,
  executeSafeTransaction,
  type MarketplaceChainConfig,
} from "@jinn-network/marketplace-binding";

const CONTRACTS_ROOT = new URL("../../../../contracts/", import.meta.url);

// The well-known Anvil dev key (Anvil's default account 0). Test-only funds on an ephemeral fork.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const NATIVE_PAYMENT_TYPE =
  "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1" as Hex;

/**
 * `MockTaskMechWithDelivery.deliverToMarketplace` is test-only -- it has no production ABI in
 * `@jinn-network/marketplace-binding` to consume. This slice mirrors the compiled contract
 * (`contracts/src/stubs/TaskCoordinatorTestMocks.sol`) exactly.
 */
const MOCK_MECH_DELIVER_ABI = [
  {
    type: "function",
    name: "deliverToMarketplace",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestIds", type: "bytes32[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [{ name: "deliveredRequests", type: "bool[]" }],
  },
] as const satisfies Abi;

// Canonical Safe v1.3.0 singleton + proxy factory. Both are deployed on Base Sepolia at these
// addresses, so a fork of that chain can mint a REAL Safe rather than a stub. This matters: the
// venue's one transaction path is `execTransaction` under the relayer profile, and a stub without
// `execTransaction`/`getTransactionHash`/`isOwner` would leave that whole path unexercised.
const SAFE_SINGLETON = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552" as Address;
const SAFE_PROXY_FACTORY = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2" as Address;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const DEFAULT_FORK_RPC_URL = "https://sepolia.base.org";

export function resolveForkRpcUrl(configured = process.env.JINN_MARKETPLACE_FORK_RPC_URL): string {
  return configured?.trim() || DEFAULT_FORK_RPC_URL;
}

const SAFE_SETUP_ABI = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const SAFE_PROXY_FACTORY_ABI = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "event",
    name: "ProxyCreation",
    inputs: [
      { name: "proxy", type: "address", indexed: false },
      { name: "singleton", type: "address", indexed: false },
    ],
  },
] as const satisfies Abi;

/** A live venue deployed on an ephemeral Anvil fork, handed to `withForkVenue`'s `run`. */
export interface ForkVenueDeployment {
  readonly rpcUrl: string;
  readonly chain: MarketplaceChainConfig;
  readonly account: Address;
  readonly mech: Address;
  readonly safe: Address;
  readonly stateDbPath: string;
}

/** A venue adapter under test, built by the caller against a `ForkVenueDeployment`. */
export interface ForkVenueSubject {
  claim(
    taskId: bigint,
  ): Promise<{ readonly attemptIndex: number; readonly requestId?: Hex; readonly txHash: Hex }>;
  settle(input: {
    readonly requestId: Hex;
    readonly deliveryBytes: Uint8Array;
  }): Promise<{ readonly settled: boolean }>;
  close(): void;
}

interface ForkArtifact {
  readonly abi: Abi;
  readonly bytecode: Hex;
}

async function loadArtifact(path: string): Promise<ForkArtifact> {
  const raw = await readFile(new URL(`artifacts/${path}`, CONTRACTS_ROOT), "utf8");
  return JSON.parse(raw) as ForkArtifact;
}

function randomDigest(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

/** True when `anvil` resolves on PATH and answers `--version`. Never throws or rejects. */
export async function anvilAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn("anvil", ["--version"]);
    probe.on("error", () => resolve(false));
    probe.on("exit", (code) => resolve(code === 0));
  });
}

// Computed once at module load, exactly like the escrow-lifecycle/venue-fork test files' own
// top-level `const hasAnvil = await anvilAvailable();` -- `describeForkVenueConformance` gates
// its whole `describe` block on this so the suite skips cleanly (never fails) without Foundry.
const hasAnvil = await anvilAvailable();

// Polls readiness through a viem client (never ambient `fetch` -- production kit source may not
// use ambient network APIs directly, per `.github/scripts/marketplace-source-boundaries.test.mjs`).
async function waitForRpc(url: string, timeoutMs: number): Promise<boolean> {
  const client = createPublicClient({ transport: http(url) });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await client.getChainId();
      return true;
    } catch {
      // Anvil isn't answering yet; keep polling until the cap.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Kills the Anvil child and waits for it to actually exit, so its RPC port is free on return. */
async function killAndWait(child: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

type ForkPublicClient = ReturnType<typeof createPublicClient>;
type ForkWalletClient = ReturnType<typeof createWalletClient>;

/**
 * Mints a real Safe v1.3.0 through the canonical proxy factory already present on the forked
 * chain, owned solely by `account` with threshold 1, and funds it so escrow-carrying calls can
 * pay. The venue's single transaction path is `execTransaction`, so the fork suite must run
 * against a genuine Safe -- a nonce-only stub would silently skip the whole broadcast profile.
 */
async function deploySafe(
  publicClient: ForkPublicClient,
  wallet: ForkWalletClient,
  account: Address,
): Promise<Address> {
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: "setup",
    args: [[account], 1n, ZERO_ADDRESS, "0x", ZERO_ADDRESS, ZERO_ADDRESS, 0n, ZERO_ADDRESS],
  });
  const createHash = await wallet.writeContract({
    address: SAFE_PROXY_FACTORY,
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: "createProxyWithNonce",
    args: [SAFE_SINGLETON, initializer, BigInt(`0x${randomBytes(8).toString("hex")}`)],
    account,
    chain: null,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  const created = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi: SAFE_PROXY_FACTORY_ABI, data: log.data, topics: log.topics });
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.eventName === "ProxyCreation") as
    | { args?: { proxy?: Address } }
    | undefined;
  const safe = created?.args?.proxy;
  if (safe === undefined) throw new Error("Safe proxy creation did not emit ProxyCreation");

  const fundHash = await wallet.sendTransaction({
    account,
    to: safe,
    value: parseEther("1"),
    chain: null,
  } as never);
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  return safe;
}

async function deployToday(
  publicClient: ForkPublicClient,
  wallet: ForkWalletClient,
  account: Address,
): Promise<{ chain: MarketplaceChainConfig; mech: Address; safe: Address }> {
  const deploy = async (artifact: ForkArtifact, args: readonly unknown[] = []): Promise<Address> => {
    const hash = await wallet.deployContract({ ...artifact, args, account, chain: null } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("deployContract produced no contract address");
    return receipt.contractAddress;
  };
  const write = async (
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    value?: bigint,
  ) => {
    const hash = await wallet.writeContract({
      address,
      abi,
      functionName,
      args,
      value,
      account,
      chain: null,
    } as never);
    return publicClient.waitForTransactionReceipt({ hash });
  };

  const [coordinatorArtifact, routerArtifact, marketplaceArtifact, activityArtifact, mechArtifact] =
    await Promise.all([
      loadArtifact("src/tasks/TaskCoordinator.sol/TaskCoordinator.json"),
      loadArtifact("src/staking/JinnRouterV3.sol/JinnRouterV3.json"),
      loadArtifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json"),
      loadArtifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskActivityChecker.json"),
      loadArtifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json"),
    ]);

  const coordinator = await deploy(coordinatorArtifact);
  const marketplace = await deploy(marketplaceArtifact);
  const activity = await deploy(activityArtifact);
  const router = await deploy(routerArtifact);
  const safe = await deploySafe(publicClient, wallet, account);
  await write(coordinator, coordinatorArtifact.abi, "initialize", [account, router]);
  await write(router, routerArtifact.abi, "initialize", [account, marketplace, coordinator, activity]);
  // The mech's operator is the SAFE, not the signing EOA: the router checks the claimant against
  // `mech.operator()`, and every venue write arrives as a Safe `execTransaction`.
  const mech = await deploy(mechArtifact, [parseEther("0.0001"), NATIVE_PAYMENT_TYPE, safe, marketplace]);

  return {
    chain: {
      chainId: 84532,
      taskCoordinator: coordinator,
      jinnRouter: router,
      mechMarketplace: marketplace,
      activityChecker: activity,
      generation: "today",
    },
    mech,
    safe,
  };
}

/**
 * The revised (V4) generation deploy is not a today-generation artifact swap: `JinnRouterV4`
 * takes an ERC20 payment token + `MockTokenBalanceTracker` and the marketplace leg is
 * signed-delivery (`MockTokenMarketplace.deliverMarketplaceWithSignatures`), not
 * `claimTask`/`deliverToMarketplace`. No test in this task exercises `generation: "revised"`
 * (`venue-fork.test.ts` and the example `describeForkVenueConformance` calls are both
 * today-only), so wiring it here would be speculative, untested code. Left as a named gap for
 * whichever task first needs a revised-generation fork.
 */
async function deployRevised(): Promise<{ chain: MarketplaceChainConfig; mech: Address; safe: Address }> {
  throw new Error(
    "withForkVenue: generation \"revised\" is not wired yet -- JinnRouterV4's ERC20/signed-delivery " +
      "deploy shape differs structurally from today-generation and no task-5 test exercises it",
  );
}

/**
 * Deploys a today- or revised-generation venue on an ephemeral Anvil fork of Base Sepolia and
 * hands it to `run`, tearing the fork (and its state-dir mint) down afterward whether `run`
 * resolves or throws.
 */
export async function withForkVenue<T>(options: {
  readonly generation: "today" | "revised";
  readonly run: (deployment: ForkVenueDeployment) => Promise<T>;
}): Promise<T> {
  const port = 9700 + (process.pid % 500);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", [
    "--fork-url",
    // Base documents this as its archive-capable Sepolia endpoint. The prior publicnode fallback
    // now rejects historical log reads without a personal token, which made the replay test
    // depend on a provider-specific account despite using only public testnet state.
    resolveForkRpcUrl(),
    "--port",
    String(port),
    "--silent",
  ]);
  let stateDir: string | undefined;
  try {
    const ready = await waitForRpc(rpcUrl, 12_000);
    if (!ready) throw new Error("Anvil fork prerequisite unavailable; venue-fork backbone did not run");

    const account = privateKeyToAccount(DEV_KEY);
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const wallet = createWalletClient({ account, transport: http(rpcUrl) });

    const { chain, mech, safe } =
      options.generation === "today"
        ? await deployToday(publicClient, wallet, account.address)
        : await deployRevised();

    stateDir = mkdtempSync(join(tmpdir(), "venue-fork-state-"));
    const stateDbPath = join(stateDir, "venue.db");

    return await options.run({ rpcUrl, chain, account: account.address, mech, safe, stateDbPath });
  } finally {
    await killAndWait(anvil);
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }
}

/**
 * Posts a fixture task through the deployed JinnRouterV3 and returns its `taskId`, verifying the
 * coordinator recorded the intended `maxClaims` before handing control back.
 */
async function postFixtureTask(
  deployment: ForkVenueDeployment,
  options: { readonly maxClaims?: number } = {},
): Promise<bigint> {
  const maxClaims = options.maxClaims ?? 2;
  const account = privateKeyToAccount(DEV_KEY);
  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(deployment.rpcUrl) });
  const solutionMaxDeliveryRate = parseEther("0.0001");
  const verdictMaxDeliveryRate = parseEther("0.0001");
  // The router escrows exactly one claim's worth of both rates per claim slot and rejects any
  // other `value`, so a task's budget and its claim ceiling are always exhausted together.
  const value = (solutionMaxDeliveryRate + verdictMaxDeliveryRate) * BigInt(maxClaims);

  const hash = await wallet.writeContract({
    address: deployment.chain.jinnRouter,
    abi: JINN_ROUTER_V3_ABI,
    functionName: "createTask",
    args: [
      randomDigest(),
      randomDigest(),
      { maxClaims, allowSolverSelfEvaluation: true },
      solutionMaxDeliveryRate,
      verdictMaxDeliveryRate,
      60n,
    ],
    value,
    account,
    chain: null,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const created = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics });
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.eventName === "TaskCreated") as { args?: { taskId?: bigint } } | undefined;
  if (created?.args?.taskId === undefined) throw new Error("fixture task creation did not emit TaskCreated");
  const taskId = created.args.taskId;

  const task = (await publicClient.readContract({
    address: deployment.chain.taskCoordinator,
    abi: TASK_COORDINATOR_ABI,
    functionName: "getTask",
    args: [taskId],
  })) as { policy: { maxClaims: number } };
  if (task.policy.maxClaims !== maxClaims) {
    throw new Error(
      `fixture task ${taskId} recorded maxClaims=${task.policy.maxClaims}, expected ${maxClaims}`,
    );
  }
  return taskId;
}

/**
 * Delivers a fixture solution for `requestId` through the deployed mech and returns the payload.
 * The mech only accepts its operator, which is the Safe, so the call goes out as a one-off Safe
 * `execTransaction` via the binding's single-shot helper -- deliberately NOT the venue's own
 * broadcaster, so the fixture never borrows the subject under test.
 */
async function deliverFixture(deployment: ForkVenueDeployment, requestId: Hex): Promise<Uint8Array> {
  const account = privateKeyToAccount(DEV_KEY);
  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(deployment.rpcUrl) });
  const deliveryBytes = randomBytes(32);

  await executeSafeTransaction(publicClient, wallet, {
    safeAddress: deployment.safe,
    to: deployment.mech,
    value: 0n,
    data: encodeFunctionData({
      abi: MOCK_MECH_DELIVER_ABI,
      functionName: "deliverToMarketplace",
      args: [[requestId], [toHex(deliveryBytes)]],
    }),
  });
  return deliveryBytes;
}

/**
 * Runs, against a real Anvil fork, the end-to-end legs the fresh venue-base adapters must
 * satisfy: a claim writes an attempt, a one-slot task's second claim surfaces the decoded
 * `TCMaxClaimsReached` revert, a delivered attempt settles idempotently, and two concurrent
 * writes through one sender land at consecutive nonces.
 */
export function describeForkVenueConformance(
  build: (deployment: ForkVenueDeployment) => Promise<ForkVenueSubject>,
): void {
  describe.runIf(hasAnvil)("venue adapters against a forked chain", () => {
    test("a claim writes a TaskAttemptCreated attempt and returns its index and requestId", async () => {
      await withForkVenue({
        generation: "today",
        async run(deployment) {
          const subject = await build(deployment);
          try {
            const taskId = await postFixtureTask(deployment);
            const claim = await subject.claim(taskId);
            expect(claim.attemptIndex).toBe(0);
            expect(claim.requestId).toMatch(/^0x[0-9a-f]{64}$/u);
            expect(claim.txHash).toMatch(/^0x[0-9a-f]{64}$/u);
          } finally {
            subject.close();
          }
        },
      });
    }, 120_000);

    // The exhausted-slot revert reaches the caller by NAME, not as a raw selector blob -- that
    // legibility is the obligation. Which name fires is the venue's business: the router checks
    // escrow before the coordinator checks the claim ceiling, and a task's escrow is sized to its
    // ceiling exactly, so a one-slot task always reports the budget error first.
    test("a second claim on a one-slot task surfaces a decoded inner revert, not a raw selector", async () => {
      await withForkVenue({
        generation: "today",
        async run(deployment) {
          const subject = await build(deployment);
          try {
            const taskId = await postFixtureTask(deployment, { maxClaims: 1 });
            await subject.claim(taskId);
            await expect(subject.claim(taskId)).rejects.toThrow(
              /RouterInsufficientTaskBudget|TCMaxClaimsReached|TCOperatorClaimLimitReached/u,
            );
          } finally {
            subject.close();
          }
        },
      });
    }, 120_000);

    test("settlement of a delivered attempt succeeds once and is idempotent on replay", async () => {
      await withForkVenue({
        generation: "today",
        async run(deployment) {
          const subject = await build(deployment);
          try {
            const taskId = await postFixtureTask(deployment);
            const claim = await subject.claim(taskId);
            const deliveryBytes = await deliverFixture(deployment, claim.requestId!);
            const first = await subject.settle({ requestId: claim.requestId!, deliveryBytes });
            expect(first.settled).toBe(true);
            const replay = await subject.settle({ requestId: claim.requestId!, deliveryBytes });
            expect(replay.settled).toBe(true);
          } finally {
            subject.close();
          }
        },
      });
    }, 180_000);

    test("two concurrent writes through one Safe both land, at consecutive EOA nonces", async () => {
      await withForkVenue({
        generation: "today",
        async run(deployment) {
          const subject = await build(deployment);
          try {
            // Posted sequentially: the fixture creator signs with the same EOA and viem assigns
            // its nonce automatically, so concurrent posts would collide before the subject is
            // even involved. The concurrency under test is the two claims sharing one Safe.
            const a = await postFixtureTask(deployment);
            const b = await postFixtureTask(deployment);
            const claims = await Promise.all([subject.claim(a), subject.claim(b)]);
            expect(new Set(claims.map((claim) => claim.txHash)).size).toBe(2);
          } finally {
            subject.close();
          }
        },
      });
    }, 180_000);
  });
}
