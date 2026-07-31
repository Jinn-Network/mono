/**
 * Shared fixtures for Task 16 (cutover stage 1 — retire the TaskEngine solution
 * path and joinedSolverNets claim gating). See
 * docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md Task 16.
 *
 * `engineFixture()` wraps the real `TaskEngine` — `canAcceptTask` is the raw
 * production method; `observe`/`process` are a thin convenience layer over the
 * real `observe()`/`process()` step function (looping the real per-step
 * `process()` to a terminal state, exactly like the daemon's engine-tick loop
 * does via repeated calls). No transition method is stubbed or faked — claim(),
 * takePreSnapshot(), runImpl(), pack(), and deliver() all run for real; only the
 * chain/IPFS I/O leaves (contracts.js, ipfs.js) are mocked by the importing test
 * file, matching this repo's existing MOCK_JUSTIFICATION convention.
 *
 * `adapterFixture()` wraps the real `MechAdapter` — `watchForTasks()` is the raw
 * production generator. `initialize()` is bypassed (it would make the fixture
 * async, and the plan's test code constructs the fixture synchronously); the
 * same publicClient/requestBlockCursor fields `initialize()` would have set are
 * assigned directly, mirroring what every existing adapter.test.ts case already
 * does immediately after `await adapter.initialize()`.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { TaskEngine, type TaskEngineOptions } from '../../src/harnesses/engine/engine.js';
import { TaskRunState } from '../../src/harnesses/engine/state.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import type { Harness, Solution } from '../../src/harnesses/types.js';
import type { Task } from '../../src/types/task.js';
import {
  legacyRestorationResultFromDelivery,
  LEGACY_ENVELOPE_EXTENSION_KEY,
} from '../../src/daemon/bridge-legacy-delivery.js';
import { MechAdapter } from '../../src/adapters/mech/adapter.js';
import type { MechAdapterConfig } from '../../src/adapters/mech/types.js';
import {
  decodeTaskCreatedLogs,
  decodeSolutionDeliveryClaimedLogs,
} from '../../src/adapters/mech/contracts.js';
import { fetchFromIpfs, fetchSignedTaskFromIpfs } from '../../src/adapters/mech/ipfs.js';

// ── engineFixture ─────────────────────────────────────────────────────────────

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const SAFE_ADDRESS = `0x${'aa'.repeat(20)}` as `0x${string}`;
const MECH_CONTRACT_ADDRESS = `0x${'bb'.repeat(20)}` as `0x${string}`;
const ROUTER_ADDRESS = `0x${'cc'.repeat(20)}` as `0x${string}`;

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'engine-fixture-'));
}

/**
 * A minimal always-ready Harness. `run()` reports a PASS verdict so
 * `verdictCodeForTask` (consulted by `deliver()` for evaluation-role rows)
 * always has a recognised value to resolve.
 */
function stubHarness(): Harness {
  return {
    name: 'stub-harness',
    version: '1.0.0',
    supports: () => true,
    isReady: async () => ({ ready: true }),
    run: async (): Promise<Solution> => ({
      venueRef: { name: 'stub' },
      // 'SCORED' is a recognised value for both TaskEngine.verdictCodeForTask
      // (which maps it to VerdictCode.Pass) and the verdictPayload the
      // evaluator-role envelope assembler requires below.
      gating: { verdict: 'SCORED' },
      verdictPayload: { verdict: 'SCORED' },
      postSnapshot: { capturedAt: Date.now(), hlTime: 0, payload: {} },
      fills: [],
    }),
  };
}

// solverType 'legacy.v0' is the passthrough SolverType (src/types/payloads/index.ts)
// — no structural payload-schema validation — so this fixture's minimal stub
// verdictPayload above doesn't need to satisfy a real SolverType's (e.g.
// prediction.v1's) full verdict schema (resolutionSource, benchmark, ...).
export function restorationTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'req-restoration-1',
    description: 'test restoration task',
    solverType: 'legacy.v0',
    role: 'restoration',
    window: { startTs: Date.now() - 1_000, endTs: Date.now() + 60_000 },
    ...overrides,
  };
}

export function evaluationTask(
  opts: { bridged?: boolean } & Partial<Task> = {},
): Task {
  const { bridged, ...overrides } = opts;
  const base: Task = {
    id: 'req-evaluation-1',
    description: 'test evaluation task',
    solverType: 'legacy.v0',
    role: 'evaluation',
    window: { startTs: Date.now() - 1_000, endTs: Date.now() + 60_000 },
    ...overrides,
  };
  if (!bridged) return base;

  // Exercise the real bridge parser (Task 15,
  // src/daemon/bridge-legacy-delivery.ts) so a "bridged" fixture task really
  // does carry a restorationResult recovered from a converged Delivery's
  // legacy-envelope extension, not a hand-typed stand-in.
  const restorationResult = 'legacy restoration result payload';
  const sealedDelivery = new TextEncoder().encode(JSON.stringify({
    [LEGACY_ENVELOPE_EXTENSION_KEY]: restorationResult,
  }));
  const parsed = legacyRestorationResultFromDelivery(sealedDelivery);
  return {
    ...base,
    context: { ...(base.context ?? {}), restorationResult: parsed },
  };
}

export interface EngineFixture {
  canAcceptTask: TaskEngine['canAcceptTask'];
  /** Inserts a DISCOVERED row for `task` (real `observe()`) and returns its requestId. */
  observe(task: Task): Promise<string>;
  /**
   * Drives the real per-step `process()` forward until the row reaches a
   * terminal state (COMPLETE / FAILED / RACE_LOST) or a bounded number of
   * steps is exhausted — the same "call process() repeatedly" shape the
   * daemon's engine-tick loop uses, just looped here instead of across
   * daemon ticks.
   */
  process(requestId: string): Promise<void>;
}

export function engineFixture(opts: { store?: Store } = {}): EngineFixture {
  const store = opts.store ?? new Store(':memory:');
  const tmp = mkTmp();
  const engineOpts: TaskEngineOptions = {
    store,
    paths: { workingDirRoot: join(tmp, 'work'), implStateDirRoot: join(tmp, 'impl') },
    implRegistry: { findFor: () => stubHarness() },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: SAFE_ADDRESS,
    },
    deliveryDeps: {
      publicClient: {} as TaskEngineOptions['deliveryDeps'] extends infer D ? (D extends { publicClient: infer P } ? P : never) : never,
      walletClient: {} as TaskEngineOptions['deliveryDeps'] extends infer D ? (D extends { walletClient: infer W } ? W : never) : never,
      safeAddress: SAFE_ADDRESS,
      mechContractAddress: MECH_CONTRACT_ADDRESS,
      routerAddress: ROUTER_ADDRESS,
      claimDeliveryVariant: 'v2',
    },
  };
  const engine = new TaskEngine(engineOpts);
  const persistence = new TaskRunPersistence(store.db);

  return {
    canAcceptTask: (input) => engine.canAcceptTask(input),

    async observe(task: Task): Promise<string> {
      const requestId = task.id;
      const now = Date.now();
      await engine.observe({
        requestId,
        taskCid: `bafy-${requestId}`,
        onchainCreationTx: `0x${'11'.repeat(32)}`,
        onchainCreationBlock: 100,
        solverType: task.solverType,
        taskRole: task.role ?? 'restoration',
        windowStartTs: task.window?.startTs ?? now - 1_000,
        windowEndTs: task.window?.endTs ?? now + 60_000,
        task,
      });
      return requestId;
    },

    async process(requestId: string): Promise<void> {
      const TERMINAL = new Set([
        TaskRunState.COMPLETE,
        TaskRunState.FAILED,
        TaskRunState.RACE_LOST,
      ]);
      // Bounded: DISCOVERED -> CLAIMED -> WAITING -> (chained to POST_SNAPSHOT)
      // -> (chained to DELIVERING) -> COMPLETE is 5 real steps; 10 is headroom.
      for (let i = 0; i < 10; i++) {
        const row = persistence.getOrThrow(requestId);
        if (TERMINAL.has(row.state)) return;
        await engine.process(requestId);
      }
    },
  };
}

// ── adapterFixture ────────────────────────────────────────────────────────────

const ADAPTER_REQUEST_ID = `0x${'aa'.repeat(32)}` as `0x${string}`;
const ADAPTER_TASK_CID_DIGEST = `0x${'cc'.repeat(32)}` as `0x${string}`;
const ADAPTER_TASK_CID = `f01551220${'cc'.repeat(32)}`;
const ADAPTER_MANIFEST_DIGEST = `0x${'99'.repeat(32)}` as `0x${string}`;
const ADAPTER_TX_HASH = `0x${'12'.repeat(32)}` as `0x${string}`;
const ADAPTER_CREATION_TX = `0x${'34'.repeat(32)}` as `0x${string}`;

const ADAPTER_CONFIG: MechAdapterConfig = {
  rpcUrl: 'http://localhost:8545',
  mechMarketplaceAddress: `0x${'11'.repeat(20)}` as `0x${string}`,
  routerAddress: `0x${'22'.repeat(20)}` as `0x${string}`,
  mechContractAddress: `0x${'33'.repeat(20)}` as `0x${string}`,
  safeAddress: `0x${'44'.repeat(20)}` as `0x${string}`,
  agentEoaPrivateKey: `0x${'55'.repeat(32)}` as `0x${string}`,
  ipfsRegistryUrl: 'http://localhost:5001',
  ipfsGatewayUrl: 'http://localhost:8080',
  pollIntervalMs: 1_000,
  chainId: 8453,
  routerClaimDeliveryVariant: 'v1',
};

function signedTaskFixture(id: string): unknown {
  return {
    schemaVersion: 'task.v1',
    id,
    solverType: 'prediction.v1',
    contractId: 'prediction',
    contractVersion: 'v1',
    solverNetManifestCid: 'bafyfixturecid',
    role: 'restoration',
    description: 'fixture task',
    window: { startTs: Date.now() - 600_000, endTs: Date.now() + 3_600_000 },
    spec: {
      venue: 'polymarket',
      marketId: 'market-1',
      conditionId: `0x${'11'.repeat(32)}`,
      outcomeTokenId: '123',
      outcome: 'YES',
    },
    eligibility: {},
    claimPolicy: { mode: 'parallel', maxClaims: 25, maxClaimsPerOperator: 1, claimLeaseTtlSeconds: 600 },
    creator: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    createdAt: 1_775_000_000_000,
    signature: {
      algo: 'secp256k1',
      signer: '0x2222222222222222222222222222222222222222',
      hash: `0x${'ab'.repeat(32)}`,
      sig: `0x${'cd'.repeat(65)}`,
    },
  };
}

export interface AdapterFixtureOpts {
  /** Router event kinds to surface in this fixture's single poll cycle. */
  routerLogs?: Array<'TaskCreated' | 'SolutionDeliveryClaimed'>;
  /**
   * Joined-SolverNet manifest CIDs (mapped onto `taskDiscovery.solverNetManifestCids`
   * — the adapter-side "joinedSolverNets" claim gate the plan retires). An
   * empty object means "joined nothing".
   */
  joinedSolverNets?: Record<string, unknown>;
}

/**
 * Builds a real `MechAdapter` wired for exactly one `watchForTasks()` poll
 * cycle. Synchronous by design (the plan's tests construct it without
 * `await`) — `initialize()` is never called; the same `publicClient` /
 * `requestBlockCursor` state it would have produced is assigned directly,
 * mirroring what adapter.test.ts's own cases already do right after
 * `await adapter.initialize()`.
 */
export function adapterFixture(opts: AdapterFixtureOpts = {}): MechAdapter {
  const routerLogs = new Set(opts.routerLogs ?? []);
  const manifestCids = opts.joinedSolverNets ? Object.keys(opts.joinedSolverNets) : undefined;

  vi.mocked(decodeTaskCreatedLogs).mockReset();
  vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReset();
  vi.mocked(fetchFromIpfs).mockReset();
  vi.mocked(fetchSignedTaskFromIpfs).mockReset();

  const taskCreatedEvent = {
    taskId: '1',
    taskCidDigest: ADAPTER_TASK_CID_DIGEST,
    manifestDigest: ADAPTER_MANIFEST_DIGEST,
    creator: ADAPTER_CONFIG.safeAddress,
    transactionHash: ADAPTER_CREATION_TX,
    blockNumber: 79,
  };

  if (routerLogs.has('TaskCreated')) {
    // Both event kinds land in the same poll cycle's log batch: the
    // TaskCreated event is decoded once (rememberCanonicalTaskCreated), which
    // primes the canonical-provenance cache the evaluation cross-check reads.
    vi.mocked(decodeTaskCreatedLogs).mockReturnValueOnce([taskCreatedEvent]);
  } else {
    // No TaskCreated event this cycle -> the canonical-provenance cache stays
    // cold, so the evaluation path's bounded canonical lookup (a *second*
    // decodeTaskCreatedLogs call, scoped to the evaluation retry) must supply
    // it instead. Mirrors adapter.test.ts's "watchForTasks yields evaluation
    // opportunities" fixture.
    vi.mocked(decodeTaskCreatedLogs)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([taskCreatedEvent]);
  }

  if (routerLogs.has('SolutionDeliveryClaimed')) {
    vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReturnValueOnce([{
      taskId: '1',
      attemptIndex: 0,
      requestId: ADAPTER_REQUEST_ID,
      operator: `0x${'66'.repeat(20)}` as `0x${string}`,
      transactionHash: ADAPTER_TX_HASH,
      blockNumber: 333,
    }]);
  } else {
    vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReturnValue([]);
  }

  vi.mocked(fetchFromIpfs).mockResolvedValue({
    data: 'solution payload',
    task: {
      cid: ADAPTER_TASK_CID,
      onchainCreationTx: ADAPTER_CREATION_TX,
      onchainCreationBlock: 79,
      requestId: ADAPTER_REQUEST_ID,
    },
  });
  vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValue(signedTaskFixture('watched-task'));

  const adapter = new MechAdapter({
    ...ADAPTER_CONFIG,
    ...(manifestCids ? { taskDiscovery: { solverNetManifestCids: manifestCids } } : {}),
  });

  // Bypass initialize() (async) — assign exactly what it would have set.
  (adapter as unknown as { publicClient: unknown }).publicClient = {
    getBlockNumber: vi.fn().mockResolvedValue(101n),
    getLogs: vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]),
    readContract: vi.fn().mockResolvedValue(false),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
  };
  (adapter as unknown as { walletClient: unknown }).walletClient = {};
  (adapter as unknown as { requestBlockCursor: bigint }).requestBlockCursor = 100n;

  return adapter;
}
