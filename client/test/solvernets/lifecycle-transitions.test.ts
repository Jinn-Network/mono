/**
 * Tests for the SolverNet lifecycle transition state machine (Task 10).
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §10 (post-launch
 * dashboard), §11 (generator ownership), Decision 11 in §17 (Pause + Resume +
 * Retire surface).
 *
 * Phases (forward-only, simpler than launch's 5-phase machine):
 *
 *   broadcasting → confirming → status: <target>
 *
 * Side effects fire after the record's status flips to the target:
 *
 *   target = 'paused' | 'retired'  → stopGenerator
 *   target = 'launched' (resume)   → startGenerator
 *
 * State transitions allowed:
 *
 *   launched → paused
 *   launched → retired
 *   paused   → launched
 *   paused   → retired
 *   retired  → ANY  (rejected — terminal)
 *
 * Idempotency invariants:
 *
 *   - record.status === target → no-op (returns record unchanged).
 *   - retired → retired → no-op (terminal but the call is harmless if the
 *     state already matches).
 *   - lifecycleProgress.target same as call target → resume from checkpoint.
 *   - lifecycleProgress.target different → reject (one transition in flight
 *     at a time per record).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  createSolverNetStore,
  type LaunchedSolverNetRecord,
  type SolverNetStore,
} from '../../src/solvernets/store.js';
import { manifestHash } from '../../src/solvernets/manifest.js';
import {
  signManifest,
  type UnsignedSolverNetManifestV1,
} from '../../src/solvernets/manifest.js';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';
import type {
  SignerWithAgentEoa,
  SolverNetRegistryClient,
} from '../../src/solvernets/registry-client.js';
import type { SetMetadataEvent } from '../../src/solvernets/most-recent-wins.js';
import {
  type SubgraphClient,
} from '../../src/solvernets/registry-client-erc8004.js';

import {
  LifecycleTransition,
  recoverInFlightLifecycleTransitions,
  type LifecycleTransitionDeps,
  DEFAULT_LIFECYCLE_MAX_ATTEMPTS,
} from '../../src/solvernets/lifecycle-transitions.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function buildUnsignedManifest(args: {
  agentEoa: `0x${string}`;
  agentId?: string;
  safeAddress?: `0x${string}`;
  solverNetId?: string;
}): UnsignedSolverNetManifestV1 {
  return {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: args.solverNetId ?? 'launcher-1_prediction-001',
    network: 'base-sepolia',
    name: 'Prediction Markets — Test',
    description: 'A test SolverNet for lifecycle transition tests.',
    launcher: {
      safeAddress:
        args.safeAddress ?? ('0x1111111111111111111111111111111111111111' as `0x${string}`),
      agentEoa: args.agentEoa,
      agentId: args.agentId ?? '5474',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: {
        task: { type: 'object' },
        solution: { type: 'object' },
        verdict: { type: 'object' },
      },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 10,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      credentialRequirements: { creator: [], solver: [], evaluator: [] },
      evaluationFunction: {
        id: 'prediction.brier-loss.v1',
        deterministic: true,
        inputs: ['solution', 'resolution'],
        output: 'verdict',
        implementation: 'jinn:harness:prediction-v1-evaluator',
      },
      aggregationFunction: {
        id: 'prediction.trailing-mean-brier-spread.v1',
        deterministic: true,
        inputs: ['verdict[]'],
        output: 'score',
        windowDays: 30,
      },
    },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
    createdAt: '2026-05-06T00:00:00Z',
    launchedAt: '2026-05-06T00:01:00Z',
  };
}

async function buildSignedManifest(args: {
  agentId?: string;
  safeAddress?: `0x${string}`;
  solverNetId?: string;
} = {}): Promise<{
  manifest: SolverNetManifestV1;
  signer: SignerWithAgentEoa;
}> {
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  const unsigned = buildUnsignedManifest({
    agentEoa: acct.address,
    agentId: args.agentId,
    safeAddress: args.safeAddress,
    solverNetId: args.solverNetId,
  });
  const manifest = await signManifest(unsigned, pk);
  return {
    manifest,
    signer: {
      agentEoaAddress: acct.address,
      agentEoaPrivateKey: pk,
      agentId: args.agentId ?? '5474',
    },
  };
}

/**
 * Construct a launched record in `status: 'launched'` with no in-flight
 * lifecycle transition. Tests can mutate it for crash-resume scenarios.
 */
function makeLaunchedRecord(args: {
  manifest: SolverNetManifestV1;
  signer: SignerWithAgentEoa;
  status?: LaunchedSolverNetRecord['status'];
  cid?: string;
}): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: args.manifest.solverNetId,
    manifestCid: args.cid ?? 'bafy-test-launched-1',
    manifestHash: manifestHash(args.manifest),
    launcherAgentId: args.signer.agentId,
    launcherSafeAddress: args.manifest.launcher.safeAddress,
    launchedAt: '2026-05-06T00:00:00.000Z',
    status: args.status ?? 'launched',
    statusUpdatedAt: '2026-05-06T00:00:00.000Z',
    generatorEnabled: true,
    registry: {
      metadataTxHash: `0x${'aa'.repeat(32)}` as `0x${string}`,
      metadataBlockNumber: 100,
    },
  };
}

// ── Mocks ───────────────────────────────────────────────────────────────────

interface MockRegistry extends SolverNetRegistryClient {
  publishLifecycleCalls: Array<{
    manifestCid: string;
    launcherAgentId: string;
    target: 'launched' | 'paused' | 'retired';
  }>;
  failNextPublishLifecycle: { error: Error } | null;
}

function makeMockRegistry(): MockRegistry {
  const publishLifecycleCalls: Array<{
    manifestCid: string;
    launcherAgentId: string;
    target: 'launched' | 'paused' | 'retired';
  }> = [];
  let failNextPublishLifecycle: { error: Error } | null = null;
  let nextBlock = 200;
  return {
    async publishManifest() {
      throw new Error('not used in lifecycle tests');
    },
    async publishLifecycleTransition(args) {
      if (failNextPublishLifecycle) {
        const err = failNextPublishLifecycle.error;
        failNextPublishLifecycle = null;
        throw err;
      }
      publishLifecycleCalls.push({
        manifestCid: args.manifestCid,
        launcherAgentId: args.launcherAgentId,
        target: args.target,
      });
      return {
        metadataTxHash: `0x${'bb'.repeat(31)}${publishLifecycleCalls.length
          .toString(16)
          .padStart(2, '0')}` as `0x${string}`,
        metadataBlockNumber: nextBlock++,
      };
    },
    async listLaunched() { return { summaries: [], failedCount: 0 }; },
    async getManifest() { throw new Error('not used'); },
    async getManifestFromCache() { return null; },
    async getLifecycleStatus() { throw new Error('not used'); },
    get publishLifecycleCalls() { return publishLifecycleCalls; },
    get failNextPublishLifecycle() { return failNextPublishLifecycle; },
    set failNextPublishLifecycle(v) { failNextPublishLifecycle = v; },
  };
}

interface MockSubgraph extends SubgraphClient {
  events: SetMetadataEvent[];
}

function makeMockSubgraph(): MockSubgraph {
  const events: SetMetadataEvent[] = [];
  return {
    async fetchSetMetadataEvents(args) {
      return events.filter((e) => e.key.startsWith(args.keyPrefix));
    },
    async fetchSetMetadataEventsForCid(args) {
      return events.filter((e) => e.key === `solvernet-manifest:${args.manifestCid}`);
    },
    get events() { return events; },
  };
}

interface ConfirmSpy {
  confirms: Array<`0x${string}`>;
  failureForHash: Map<`0x${string}`, Error>;
  awaitTxConfirmation: (txHash: `0x${string}`) => Promise<{ blockNumber: number }>;
}

function makeConfirmSpy(): ConfirmSpy {
  const confirms: Array<`0x${string}`> = [];
  const failureForHash = new Map<`0x${string}`, Error>();
  let nextBlock = 300;
  return {
    get confirms() { return confirms; },
    get failureForHash() { return failureForHash; },
    async awaitTxConfirmation(txHash) {
      const failure = failureForHash.get(txHash);
      if (failure) {
        failureForHash.delete(txHash);
        throw failure;
      }
      confirms.push(txHash);
      return { blockNumber: nextBlock++ };
    },
  };
}

interface GeneratorSpy {
  starts: LaunchedSolverNetRecord[];
  stops: LaunchedSolverNetRecord[];
  failNextStart: { error: Error } | null;
  failNextStop: { error: Error } | null;
  startGenerator: (record: LaunchedSolverNetRecord) => Promise<void>;
  stopGenerator: (record: LaunchedSolverNetRecord) => Promise<void>;
}

function makeGeneratorSpy(): GeneratorSpy {
  const starts: LaunchedSolverNetRecord[] = [];
  const stops: LaunchedSolverNetRecord[] = [];
  let failNextStart: { error: Error } | null = null;
  let failNextStop: { error: Error } | null = null;
  return {
    get starts() { return starts; },
    get stops() { return stops; },
    get failNextStart() { return failNextStart; },
    set failNextStart(v) { failNextStart = v; },
    get failNextStop() { return failNextStop; },
    set failNextStop(v) { failNextStop = v; },
    async startGenerator(record) {
      if (failNextStart) {
        const err = failNextStart.error;
        failNextStart = null;
        throw err;
      }
      starts.push(record);
    },
    async stopGenerator(record) {
      if (failNextStop) {
        const err = failNextStop.error;
        failNextStop = null;
        throw err;
      }
      stops.push(record);
    },
  };
}

// ── Setup ───────────────────────────────────────────────────────────────────

let baseDir: string;
let store: SolverNetStore;
let registry: MockRegistry;
let subgraph: MockSubgraph;
let confirmSpy: ConfirmSpy;
let generatorSpy: GeneratorSpy;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'lifecycle-tx-'));
  store = createSolverNetStore({ baseDir });
  registry = makeMockRegistry();
  subgraph = makeMockSubgraph();
  confirmSpy = makeConfirmSpy();
  generatorSpy = makeGeneratorSpy();
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(
  signer: SignerWithAgentEoa,
  overrides: Partial<LifecycleTransitionDeps> = {},
): LifecycleTransitionDeps {
  return {
    store,
    registry,
    signer,
    subgraph,
    startGenerator: generatorSpy.startGenerator,
    stopGenerator: generatorSpy.stopGenerator,
    awaitTxConfirmation: confirmSpy.awaitTxConfirmation,
    now: () => new Date('2026-05-06T01:00:00.000Z'),
    ...overrides,
  };
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe('LifecycleTransition.transition — happy path', () => {
  it('pause: launched → paused, stopGenerator fired, lifecycleProgress cleared', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    const advanced = await action.transition(record, 'paused');

    expect(advanced.status).toBe('paused');
    expect(advanced.lifecycleProgress).toBeUndefined();
    expect(advanced.statusUpdatedAt).toBe('2026-05-06T01:00:00.000Z');
    expect(advanced.registry.metadataTxHash).toMatch(/^0x[0-9a-f]+$/);

    // Side effect.
    expect(generatorSpy.stops).toHaveLength(1);
    expect(generatorSpy.stops[0]?.solverNetId).toBe(record.solverNetId);
    expect(generatorSpy.starts).toHaveLength(0);

    // Registry was called once with target='paused'.
    expect(registry.publishLifecycleCalls).toHaveLength(1);
    expect(registry.publishLifecycleCalls[0]?.target).toBe('paused');
    expect(registry.publishLifecycleCalls[0]?.manifestCid).toBe(record.manifestCid);
    expect(registry.publishLifecycleCalls[0]?.launcherAgentId).toBe(signer.agentId);

    // Persisted record matches returned record.
    const onDisk = await store.loadRecord(record.solverNetId);
    expect(onDisk).toEqual(advanced);
  });

  it('resume: paused → launched, startGenerator fired', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'paused' });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    const advanced = await action.transition(record, 'launched');

    expect(advanced.status).toBe('launched');
    expect(advanced.lifecycleProgress).toBeUndefined();
    expect(generatorSpy.starts).toHaveLength(1);
    expect(generatorSpy.stops).toHaveLength(0);
  });

  it('retire from launched: → retired, stopGenerator fired', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    const advanced = await action.transition(record, 'retired');

    expect(advanced.status).toBe('retired');
    expect(generatorSpy.stops).toHaveLength(1);
    expect(generatorSpy.starts).toHaveLength(0);
  });

  it('retire from paused: → retired, stopGenerator fired (the spy does not know we double-stopped)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'paused' });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    const advanced = await action.transition(record, 'retired');

    expect(advanced.status).toBe('retired');
    // We DO call stopGenerator on the retire-from-paused path. The spec
    // explicitly tolerates redundant stop calls — the daemon-side spawner
    // (Task 11/12) is responsible for making stop a no-op when already
    // stopped. The state machine errs on the side of always firing the
    // side effect for the target status.
    expect(generatorSpy.stops).toHaveLength(1);
    expect(generatorSpy.starts).toHaveLength(0);
  });

  it('pause → resume → retire chain: ends at retired with two stops + one start in order', async () => {
    const { manifest, signer } = await buildSignedManifest();
    let record = makeLaunchedRecord({ manifest, signer });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));

    record = await action.transition(record, 'paused');
    expect(record.status).toBe('paused');

    record = await action.transition(record, 'launched');
    expect(record.status).toBe('launched');

    record = await action.transition(record, 'retired');
    expect(record.status).toBe('retired');

    expect(generatorSpy.stops.map((r) => r.status)).toEqual(['paused', 'retired']);
    expect(generatorSpy.starts.map((r) => r.status)).toEqual(['launched']);
    expect(registry.publishLifecycleCalls.map((c) => c.target)).toEqual([
      'paused',
      'launched',
      'retired',
    ]);
  });

  it('persists progress before each side effect (broadcasting → confirming → cleared)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer });
    await store.writeRecord(record);

    const observed: Array<{
      phase: string | undefined;
      status: string;
    }> = [];

    const recordingObserver = async (): Promise<void> => {
      const r = await store.loadRecord(record.solverNetId);
      if (r) {
        observed.push({
          phase: r.lifecycleProgress?.phase,
          status: r.status,
        });
      }
    };

    // Wrap registry to peek before publishLifecycleTransition.
    const wrappedRegistry: SolverNetRegistryClient = {
      ...registry,
      async publishLifecycleTransition(args) {
        await recordingObserver();
        return registry.publishLifecycleTransition(args);
      },
    };

    const wrappedConfirm = async (txHash: `0x${string}`) => {
      await recordingObserver();
      return confirmSpy.awaitTxConfirmation(txHash);
    };

    const action = new LifecycleTransition(
      makeDeps(signer, {
        registry: wrappedRegistry,
        awaitTxConfirmation: wrappedConfirm,
      }),
    );

    await action.transition(record, 'paused');

    // 1. publishLifecycleTransition fires while record is at 'broadcasting'.
    // 2. awaitTxConfirmation fires while record is at 'confirming'.
    expect(observed).toHaveLength(2);
    expect(observed[0]?.phase).toBe('broadcasting');
    expect(observed[0]?.status).toBe('launched');
    expect(observed[1]?.phase).toBe('confirming');
    expect(observed[1]?.status).toBe('launched');
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe('LifecycleTransition — idempotency', () => {
  it('pause an already-paused record → no-op (no side effects, returns record unchanged)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'paused' });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    const result = await action.transition(record, 'paused');

    expect(result.status).toBe('paused');
    expect(result.lifecycleProgress).toBeUndefined();
    expect(registry.publishLifecycleCalls).toHaveLength(0);
    expect(generatorSpy.stops).toHaveLength(0);
    expect(generatorSpy.starts).toHaveLength(0);
  });

  it('resume an already-launched record → no-op (no side effects)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'launched' });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    const result = await action.transition(record, 'launched');

    expect(result.status).toBe('launched');
    expect(registry.publishLifecycleCalls).toHaveLength(0);
    expect(generatorSpy.stops).toHaveLength(0);
    expect(generatorSpy.starts).toHaveLength(0);
  });

  it('retire an already-retired record → no-op (terminal but harmless to re-call)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'retired' });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    const result = await action.transition(record, 'retired');

    expect(result.status).toBe('retired');
    expect(registry.publishLifecycleCalls).toHaveLength(0);
  });

  it('double pause: pause then pause again → second is no-op, only one event recorded', async () => {
    const { manifest, signer } = await buildSignedManifest();
    let record = makeLaunchedRecord({ manifest, signer });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));

    record = await action.transition(record, 'paused');
    record = await action.transition(record, 'paused');

    expect(record.status).toBe('paused');
    expect(registry.publishLifecycleCalls).toHaveLength(1);
    expect(generatorSpy.stops).toHaveLength(1);
  });
});

// ── Terminal-state rejections + invalid transitions ────────────────────────

describe('LifecycleTransition — invalid transitions', () => {
  it('retired record rejects pause/resume (terminal)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'retired' });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    await expect(action.transition(record, 'paused')).rejects.toThrow(/retired/);
    await expect(action.transition(record, 'launched')).rejects.toThrow(/retired/);
  });

  it('rejects when lifecycleProgress is set with a different target', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest, signer }),
      lifecycleProgress: { phase: 'broadcasting', target: 'paused', attemptCount: 1 },
    };
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    // Already mid-pause; can't start a retire from this record.
    await expect(action.transition(record, 'retired')).rejects.toThrow(/in flight/);
  });

  it('rejects launching → paused (state machine is for launched/paused/retired only)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'launching' });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    await expect(action.transition(record, 'paused')).rejects.toThrow(/launching|launched/);
  });

  it('rejects failed → paused (caller must reset launch state first)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'failed' });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer));
    await expect(action.transition(record, 'paused')).rejects.toThrow(/failed/);
  });
});

// ── Crash-resume from each phase ────────────────────────────────────────────

describe('LifecycleTransition.resume — crash recovery', () => {
  it('crash before broadcast (no txHash) → resume re-broadcasts and confirms', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const crashed: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest, signer, status: 'launched' }),
      lifecycleProgress: { phase: 'broadcasting', target: 'paused', attemptCount: 0 },
    };
    await store.writeRecord(crashed);

    const action = new LifecycleTransition(makeDeps(signer));
    const resumed = await action.resume(crashed);

    expect(resumed.status).toBe('paused');
    expect(resumed.lifecycleProgress).toBeUndefined();
    expect(registry.publishLifecycleCalls).toHaveLength(1);
    expect(generatorSpy.stops).toHaveLength(1);
  });

  it('crash after broadcast (txHash saved) → resume polls receipt without re-broadcast', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const knownTxHash = `0x${'cc'.repeat(32)}` as `0x${string}`;

    // Subgraph has the matching event — signals the broadcast already
    // landed.
    subgraph.events.push({
      agentId: signer.agentId,
      key: `solvernet-manifest:${makeLaunchedRecord({ manifest, signer }).manifestCid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'paused',
        at: '2026-05-06T01:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 999,
      transactionIndex: 0,
    });

    const crashed: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest, signer }),
      lifecycleProgress: {
        phase: 'confirming',
        target: 'paused',
        txHash: knownTxHash,
        attemptCount: 1,
      },
    };
    await store.writeRecord(crashed);

    const action = new LifecycleTransition(makeDeps(signer));
    const resumed = await action.resume(crashed);

    expect(resumed.status).toBe('paused');
    expect(registry.publishLifecycleCalls).toHaveLength(0); // no re-broadcast
    expect(confirmSpy.confirms).toContain(knownTxHash);
    expect(generatorSpy.stops).toHaveLength(1);
  });

  it('crash with confirming phase, no tx receipt, no subgraph event → re-broadcast', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const droppedTxHash = `0x${'dd'.repeat(32)}` as `0x${string}`;

    confirmSpy.failureForHash.set(droppedTxHash, new Error('tx not found'));

    const crashed: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest, signer }),
      lifecycleProgress: {
        phase: 'confirming',
        target: 'paused',
        txHash: droppedTxHash,
        attemptCount: 0,
      },
    };
    await store.writeRecord(crashed);

    const action = new LifecycleTransition(makeDeps(signer));
    const resumed = await action.resume(crashed);

    // Re-broadcast happened.
    expect(registry.publishLifecycleCalls).toHaveLength(1);
    expect(registry.publishLifecycleCalls[0]?.target).toBe('paused');
    expect(resumed.status).toBe('paused');
    expect(generatorSpy.stops).toHaveLength(1);
  });

  it('already-anchored: tx receipt fails but subgraph has matching event → use event blockNumber, no re-broadcast', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const lostTxHash = `0x${'ee'.repeat(32)}` as `0x${string}`;
    const cid = makeLaunchedRecord({ manifest, signer }).manifestCid;

    subgraph.events.push({
      agentId: signer.agentId,
      key: `solvernet-manifest:${cid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'paused',
        at: '2026-05-06T01:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 1234,
      transactionIndex: 5,
    });
    confirmSpy.failureForHash.set(lostTxHash, new Error('tx not found'));

    const crashed: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest, signer }),
      lifecycleProgress: {
        phase: 'confirming',
        target: 'paused',
        txHash: lostTxHash,
        attemptCount: 0,
      },
    };
    await store.writeRecord(crashed);

    const action = new LifecycleTransition(makeDeps(signer));
    const resumed = await action.resume(crashed);

    expect(resumed.status).toBe('paused');
    expect(registry.publishLifecycleCalls).toHaveLength(0);
    expect(resumed.registry.metadataBlockNumber).toBe(1234);
    expect(generatorSpy.stops).toHaveLength(1);
  });

  it('only matching-target subgraph events trigger early confirmation (paused-target ignores launched event)', async () => {
    // If the subgraph has a 'launched' event for this cid (the original
    // launch) and our pending transition is target='paused', we MUST NOT
    // treat the launched event as evidence that the pause has anchored.
    const { manifest, signer } = await buildSignedManifest();
    const droppedTxHash = `0x${'fa'.repeat(32)}` as `0x${string}`;
    const cid = makeLaunchedRecord({ manifest, signer }).manifestCid;

    subgraph.events.push({
      agentId: signer.agentId,
      key: `solvernet-manifest:${cid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'launched', // the original launch — not a pause anchor
        at: '2026-05-06T00:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 50,
      transactionIndex: 0,
    });
    confirmSpy.failureForHash.set(droppedTxHash, new Error('tx not found'));

    const crashed: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest, signer }),
      lifecycleProgress: {
        phase: 'confirming',
        target: 'paused',
        txHash: droppedTxHash,
        attemptCount: 0,
      },
    };
    await store.writeRecord(crashed);

    const action = new LifecycleTransition(makeDeps(signer));
    const resumed = await action.resume(crashed);

    // Re-broadcast triggered — the pre-existing 'launched' event doesn't
    // count as evidence that 'paused' anchored.
    expect(registry.publishLifecycleCalls).toHaveLength(1);
    expect(registry.publishLifecycleCalls[0]?.target).toBe('paused');
    expect(resumed.status).toBe('paused');
  });
});

// ── Failure handling ───────────────────────────────────────────────────────

describe('LifecycleTransition — error handling', () => {
  it('publishLifecycleTransition throws → record at broadcasting with txError, attemptCount++', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer });
    await store.writeRecord(record);

    registry.failNextPublishLifecycle = { error: new Error('execution reverted: insufficient funds') };

    const action = new LifecycleTransition(makeDeps(signer));
    await expect(action.transition(record, 'paused')).rejects.toThrow(/insufficient funds/);

    const onDisk = await store.loadRecord(record.solverNetId);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.status).toBe('launched'); // unchanged on failure
    expect(onDisk!.lifecycleProgress?.phase).toBe('broadcasting');
    expect(onDisk!.lifecycleProgress?.target).toBe('paused');
    expect(onDisk!.lifecycleProgress?.attemptCount).toBe(1);
    expect(onDisk!.lifecycleProgress?.txError?.message).toMatch(/insufficient funds/);

    // Side effect didn't fire.
    expect(generatorSpy.stops).toHaveLength(0);

    // Resume succeeds.
    const resumed = await action.resume(onDisk!);
    expect(resumed.status).toBe('paused');
    expect(generatorSpy.stops).toHaveLength(1);
  });

  it('after MAX_ATTEMPTS, status flips to failed', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer });
    await store.writeRecord(record);

    const action = new LifecycleTransition(makeDeps(signer, { maxAttempts: 2 }));

    registry.failNextPublishLifecycle = { error: new Error('rpc 503') };
    await expect(action.transition(record, 'paused')).rejects.toThrow();
    let onDisk = await store.loadRecord(record.solverNetId);
    expect(onDisk!.status).toBe('launched');
    expect(onDisk!.lifecycleProgress?.attemptCount).toBe(1);

    registry.failNextPublishLifecycle = { error: new Error('rpc 503') };
    await expect(action.resume(onDisk!)).rejects.toThrow();
    onDisk = await store.loadRecord(record.solverNetId);
    expect(onDisk!.status).toBe('failed');
    expect(onDisk!.lifecycleProgress?.attemptCount).toBe(2);
  });

  it('default max attempts constant exists and is positive', () => {
    expect(DEFAULT_LIFECYCLE_MAX_ATTEMPTS).toBeGreaterThan(0);
  });

  it('startGenerator failure does NOT roll back the record (status stays at target)', async () => {
    // Once the on-chain transition has anchored, the status is the new
    // target — generator-spawn problems are operational and don't undo the
    // anchor. The state machine surfaces the error to the caller; the daemon
    // can retry generator startup separately.
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer, status: 'paused' });
    await store.writeRecord(record);

    generatorSpy.failNextStart = { error: new Error('generator boot failed') };

    const action = new LifecycleTransition(makeDeps(signer));
    await expect(action.transition(record, 'launched')).rejects.toThrow(/generator boot failed/);

    const onDisk = await store.loadRecord(record.solverNetId);
    expect(onDisk!.status).toBe('launched');
    expect(onDisk!.lifecycleProgress).toBeUndefined();
  });
});

// ── recoverInFlightLifecycleTransitions ────────────────────────────────────

describe('recoverInFlightLifecycleTransitions', () => {
  it('scans launched dir for records with lifecycleProgress and resumes each', async () => {
    const { manifest: manifestA, signer } = await buildSignedManifest({
      solverNetId: 'sn_a',
    });
    const { manifest: manifestB } = await buildSignedManifest({
      solverNetId: 'sn_b',
      agentId: signer.agentId,
    });

    const recA: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest: manifestA, signer, cid: 'cid-a' }),
      lifecycleProgress: { phase: 'broadcasting', target: 'paused', attemptCount: 0 },
    };
    const recB: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest: manifestB, signer, cid: 'cid-b' }),
      lifecycleProgress: { phase: 'broadcasting', target: 'retired', attemptCount: 0 },
    };
    // Untouched record (no lifecycleProgress).
    const recC = makeLaunchedRecord({
      manifest: manifestA,
      signer,
      cid: 'cid-c',
    });
    recC.solverNetId = 'sn_c';

    await store.writeRecord(recA);
    await store.writeRecord(recB);
    await store.writeRecord(recC);

    const result = await recoverInFlightLifecycleTransitions(makeDeps(signer));

    expect(result.resumed).toBe(2);
    expect(result.failed).toEqual([]);

    const onDiskA = await store.loadRecord('sn_a');
    expect(onDiskA?.status).toBe('paused');
    const onDiskB = await store.loadRecord('sn_b');
    expect(onDiskB?.status).toBe('retired');
    const onDiskC = await store.loadRecord('sn_c');
    expect(onDiskC?.status).toBe('launched'); // untouched

    expect(generatorSpy.stops.map((r) => r.solverNetId).sort()).toEqual(['sn_a', 'sn_b']);
  });

  it('captures errors per-record without aborting the scan', async () => {
    const { manifest: manifestA, signer } = await buildSignedManifest({
      solverNetId: 'sn_a',
    });
    const { manifest: manifestB } = await buildSignedManifest({
      solverNetId: 'sn_b',
      agentId: signer.agentId,
    });

    const recA: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest: manifestA, signer, cid: 'cid-a' }),
      lifecycleProgress: { phase: 'broadcasting', target: 'paused', attemptCount: 0 },
    };
    const recB: LaunchedSolverNetRecord = {
      ...makeLaunchedRecord({ manifest: manifestB, signer, cid: 'cid-b' }),
      lifecycleProgress: { phase: 'broadcasting', target: 'paused', attemptCount: 0 },
    };
    await store.writeRecord(recA);
    await store.writeRecord(recB);

    // Fail recA's first publish — recB should still resume.
    let firstFail = true;
    const wrappedRegistry: SolverNetRegistryClient = {
      ...registry,
      async publishLifecycleTransition(args) {
        if (firstFail) {
          firstFail = false;
          throw new Error('chain down for sn_a');
        }
        return registry.publishLifecycleTransition(args);
      },
    };

    const result = await recoverInFlightLifecycleTransitions(
      makeDeps(signer, { registry: wrappedRegistry }),
    );

    expect(result.resumed).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error.message).toMatch(/chain down for sn_a/);
  });

  it('returns zero counts when no in-flight records exist', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const record = makeLaunchedRecord({ manifest, signer });
    await store.writeRecord(record);

    const result = await recoverInFlightLifecycleTransitions(makeDeps(signer));
    expect(result.resumed).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('returns zero counts when launched dir is empty', async () => {
    const { signer } = await buildSignedManifest();
    const result = await recoverInFlightLifecycleTransitions(makeDeps(signer));
    expect(result.resumed).toBe(0);
    expect(result.failed).toEqual([]);
  });
});
