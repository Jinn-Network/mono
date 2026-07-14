/**
 * #1393 — corpus knowledge autoload: loader unit tests.
 *
 * Store-only seams: envelope projections (via store.saveEnvelopeProjection)
 * carry solverType/role/evidenceTier; served_artifacts rows (via
 * store.saveServedArtifact) carry the artifact sha256s keyed by envelopeCid.
 * handleSearchRecords merges both; the loader ranks, dedupes, and trims.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../../src/store/store.js';
import { loadCorpusKnowledge } from '../../../src/harnesses/engine/corpus-knowledge.js';
import type { ReadOnlyCorpus } from '../../../src/mcp/search-records.js';
import type { EnvelopeProjection } from '../../../src/corpus/types.js';

function projection(overrides: Partial<EnvelopeProjection>): EnvelopeProjection {
  return {
    envelopeId: overrides.envelopeCid ?? 'env-default',
    envelopeCid: 'env-default',
    envelopeSha256: null,
    signatureHash: `0xsig-${overrides.envelopeCid ?? 'default'}`,
    solverType: 'prediction.v1',
    role: 'solution',
    taskCid: 'bafytask',
    taskId: null,
    requestId: null,
    generatedAt: 1_000,
    evidenceTier: 'self-signed',
    participantSafeAddress: '0xsafe',
    participantAgentEoa: '0xeoa',
    executorImplName: 'prediction-v1-baseline',
    executorImplVersion: '1.0.0',
    executorRuntimeBundleDigest: null,
    executorPlugins: [],
    solutionEnvelopeCid: null,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: null,
    metadata: {},
    ...overrides,
  };
}

describe('loadCorpusKnowledge (#1393)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('returns null when the store has no matching records (corpus-null)', async () => {
    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload).toBeNull();
  });

  it('ranks by evidence tier (attested > committed > self-signed) then generatedAt desc, slices 3', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-a', envelopeCid: 'env-a', evidenceTier: 'self-signed', generatedAt: 5_000 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-b', envelopeCid: 'env-b', evidenceTier: 'committed', generatedAt: 1_000 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-c', envelopeCid: 'env-c', evidenceTier: 'attested', generatedAt: 500 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-d', envelopeCid: 'env-d', evidenceTier: 'self-signed', generatedAt: 4_000 }));

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload).not.toBeNull();
    expect(payload!.records).toHaveLength(3);
    expect(payload!.records.map((r) => r.envelopeCid)).toEqual(['env-c', 'env-b', 'env-a']);
  });

  it('filters to the requested solverType and role=solution', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-sol', envelopeCid: 'env-sol' }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-verdict', envelopeCid: 'env-verdict', role: 'verdict' }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-other', envelopeCid: 'env-other', solverType: 'swe-rebench-v2.v1' }));

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload!.records.map((r) => r.envelopeCid)).toEqual(['env-sol']);
  });

  it('merges local served-artifact sha256s into records by envelopeCid', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-art', envelopeCid: 'env-art' }));
    store.saveServedArtifact({
      sha256: 'ab'.repeat(32),
      artifactType: 'prediction_v1_solution',
      envelopeCid: 'env-art',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date().toISOString(),
    });

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload!.records[0]!.artifacts).toEqual([
      expect.objectContaining({ sha256: 'ab'.repeat(32), artifactType: 'prediction_v1_solution' }),
    ]);
  });

  it('falls back to store-only results (not null) when the corpus query exceeds timeoutMs and local knowledge exists (#1393 review finding 4)', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-slow', envelopeCid: 'env-slow' }));
    const hangingCorpus: ReadOnlyCorpus = {
      query: () => new Promise(() => { /* never resolves — no AbortSignal to cancel it */ }),
      fetchManifest: () => Promise.reject(new Error('unused')),
    };
    const warnings: string[] = [];
    const payload = await loadCorpusKnowledge({
      corpus: hangingCorpus,
      store,
      solverType: 'prediction.v1',
      timeoutMs: 50,
      log: (msg) => warnings.push(msg),
    });
    // A sick network corpus must not deny local knowledge that IS available.
    expect(payload).not.toBeNull();
    expect(payload!.records.map((r) => r.envelopeCid)).toEqual(['env-slow']);
    expect(warnings.join('\n')).toContain('timed out');
    expect(warnings.join('\n')).toContain('falling back to store-only');
  });

  it('returns null when the corpus query exceeds timeoutMs and no local knowledge exists', async () => {
    const hangingCorpus: ReadOnlyCorpus = {
      query: () => new Promise(() => { /* never resolves */ }),
      fetchManifest: () => Promise.reject(new Error('unused')),
    };
    const warnings: string[] = [];
    const payload = await loadCorpusKnowledge({
      corpus: hangingCorpus,
      store,
      solverType: 'prediction.v1',
      timeoutMs: 50,
      log: (msg) => warnings.push(msg),
    });
    expect(payload).toBeNull();
    expect(warnings.join('\n')).toContain('timed out');
  });

  it('backfills artifact refs for a ranked record even when its served-artifact row falls outside the local recency window (#1393 review finding 2)', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-target', envelopeCid: 'env-target', generatedAt: 1_000 }));
    store.saveServedArtifact({
      sha256: 'aa'.repeat(32),
      artifactType: 'prediction_v1_solution',
      envelopeCid: 'env-target',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date(1_000).toISOString(),
    });
    // Two unrelated, more-recent served-artifact rows push env-target's row
    // outside a naive top-N-by-recency local join when searchLimit is small.
    store.saveServedArtifact({
      sha256: 'bb'.repeat(32),
      artifactType: 'other_type',
      envelopeCid: 'env-unrelated-1',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date(3_000).toISOString(),
    });
    store.saveServedArtifact({
      sha256: 'cc'.repeat(32),
      artifactType: 'other_type',
      envelopeCid: 'env-unrelated-2',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date(2_000).toISOString(),
    });

    const payload = await loadCorpusKnowledge({
      corpus: null,
      store,
      solverType: 'prediction.v1',
      searchLimit: 2, // smaller than the 3 served-artifact rows above
    });
    expect(payload!.records).toHaveLength(1);
    expect(payload!.records[0]!.artifacts).toEqual([
      expect.objectContaining({ sha256: 'aa'.repeat(32), artifactType: 'prediction_v1_solution' }),
    ]);
  });

  it('does not truncate the ranking pool before the tier sort — an old attested record still wins over 14 newer self-signed ones (#1393 review finding 2)', async () => {
    for (let i = 0; i < 14; i += 1) {
      store.saveEnvelopeProjection(projection({
        envelopeId: `env-recent-${i}`,
        envelopeCid: `env-recent-${i}`,
        evidenceTier: 'self-signed',
        generatedAt: 14_000 - i * 1_000,
      }));
    }
    store.saveEnvelopeProjection(projection({
      envelopeId: 'env-old-attested',
      envelopeCid: 'env-old-attested',
      evidenceTier: 'attested',
      generatedAt: 1,
    }));

    // Default searchLimit (raised from the old 12) must still admit the
    // 15th-oldest record into the ranking pool.
    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload!.records[0]!.envelopeCid).toBe('env-old-attested');
  });

  it('returns null and logs when the corpus query throws', async () => {
    const throwingCorpus: ReadOnlyCorpus = {
      query: () => Promise.reject(new Error('boom')),
      fetchManifest: () => Promise.reject(new Error('unused')),
    };
    const warnings: string[] = [];
    const payload = await loadCorpusKnowledge({
      corpus: throwingCorpus,
      store,
      solverType: 'prediction.v1',
      log: (msg) => warnings.push(msg),
    });
    expect(payload).toBeNull();
    expect(warnings.join('\n')).toContain('boom');
  });
});

// ── Engine injection tests ────────────────────────────────────────────────────

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { makeIntentInput } from '../../_support/engine.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import type { Task } from '../../../src/types/task.js';
import { claimDelivery } from '../../../src/adapters/mech/contracts.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(('0x' + 'de'.repeat(32)) as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0xdeliverytx' as `0x${string}`),
  claimDelivery: vi.fn().mockResolvedValue('0xclaimtx' as `0x${string}`),
  submitTask: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanTasks: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const SOLVER_TYPE = 'legacy.v0';

function mkTmp(): string {
  const dir = join(tmpdir(), `corpus-knowledge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stub impl that captures the ctx.task it received. */
function makeCapturingImpl(captured: { task?: Task }, role: 'restoration' | 'evaluation' = 'restoration'): Harness {
  return {
    name: 'capturing-stub',
    version: '0.0.1',
    supports: (s) => (role === 'evaluation' ? s.role === 'evaluation' : s.role !== 'evaluation') && s.solverType === SOLVER_TYPE,
    async run(ctx): Promise<Solution> {
      captured.task = ctx.task;
      return {
        venueRef: { name: 'capturing-stub' },
        gating: { ok: true },
        preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        fills: [],
      };
    },
  };
}

function engineOpts(store: Store, tmp: string, impl: Harness, knowledge?: TaskEngineOptions['knowledge']): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(tmp, 'work'), implStateDirRoot: join(tmp, 'impl') },
    implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: '0xsafe' as `0x${string}`,
    },
    ...(knowledge !== undefined ? { knowledge } : {}),
  };
}

function runInput(requestId: string, role: 'restoration' | 'evaluation' = 'restoration'): PersistedTaskRunInput {
  const now = Date.now() - 1000;
  return makeIntentInput({
    requestId,
    solverType: SOLVER_TYPE,
    taskRole: role,
    // Window already open (the shared fixture defaults to a future start).
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    task: { id: requestId, description: 'test', solverType: SOLVER_TYPE, role },
  });
}

/** observe → CLAIMED → WAITING, then one process() to drive the real runImpl. */
async function driveToPostSnapshot(engine: TaskEngine, store: Store, requestId: string, role: 'restoration' | 'evaluation' = 'restoration'): Promise<TaskRunPersistence> {
  const p = new TaskRunPersistence(store.db);
  await engine.observe(runInput(requestId, role));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  await engine.process(requestId);
  expect(p.getByRequestId(requestId)!.state).toBe(TaskRunState.POST_SNAPSHOT);
  return p;
}

describe('#1393 corpus knowledge injection in runImpl', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    vi.clearAllMocks();
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function seedProjection(cid: string): void {
    store.saveEnvelopeProjection(projection({
      envelopeId: cid,
      envelopeCid: cid,
      solverType: SOLVER_TYPE,
      role: 'solution',
      evidenceTier: 'self-signed',
      generatedAt: 2_000,
    }));
  }

  it('injects corpusKnowledge into ctx.task.context for a restoration run, persists consumedRefsJson, emits corpus_knowledge', async () => {
    seedProjection('env-prior-1');
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured)));
    const p = await driveToPostSnapshot(engine, store, 'req-know-1');

    const payload = captured.task?.context?.['corpusKnowledge'] as { records: Array<{ envelopeCid: string }> };
    expect(payload).toBeDefined();
    expect(payload.records.map((r) => r.envelopeCid)).toEqual(['env-prior-1']);

    const row = p.getByRequestId('req-know-1')!;
    expect(JSON.parse(row.consumedRefsJson!)).toEqual([
      expect.objectContaining({ envelopeCid: 'env-prior-1' }),
    ]);

    const events = store.db
      .prepare(`SELECT kind, request_id, detail FROM activity_events WHERE kind = 'corpus_knowledge'`)
      .all() as Array<{ kind: string; request_id: string; detail: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.request_id).toBe('req-know-1');
    expect(JSON.parse(events[0]!.detail)).toEqual([
      expect.objectContaining({ envelopeCid: 'env-prior-1' }),
    ]);
  });

  it('does not inject when knowledge.enabled === false (opt-out)', async () => {
    seedProjection('env-prior-2');
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured), { enabled: false }));
    const p = await driveToPostSnapshot(engine, store, 'req-know-2');

    expect(captured.task?.context?.['corpusKnowledge']).toBeUndefined();
    expect(p.getByRequestId('req-know-2')!.consumedRefsJson).toBeNull();
    const events = store.db
      .prepare(`SELECT kind FROM activity_events WHERE kind = 'corpus_knowledge'`)
      .all();
    expect(events).toHaveLength(0);
  });

  it('does not inject for evaluation runs', async () => {
    seedProjection('env-prior-3');
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured, 'evaluation')));
    const p = await driveToPostSnapshot(engine, store, 'req-know-3', 'evaluation');

    expect(captured.task?.context?.['corpusKnowledge']).toBeUndefined();
    expect(p.getByRequestId('req-know-3')!.consumedRefsJson).toBeNull();
  });

  it('proceeds normally (no injection, no failure) when the store has no matching records', async () => {
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured)));
    const p = await driveToPostSnapshot(engine, store, 'req-know-4');
    expect(captured.task?.context?.['corpusKnowledge']).toBeUndefined();
    expect(p.getByRequestId('req-know-4')!.state).toBe(TaskRunState.POST_SNAPSHOT);
  });

  it('a RUNNING retry re-drive reuses the first resolution instead of re-querying the corpus and re-emitting corpus_knowledge (#1393 review finding 3)', async () => {
    seedProjection('env-prior-retry');
    const captured: { task?: Task; runCount: number } = { runCount: 0 };
    const flaky: Harness = {
      name: 'flaky-capturing-stub',
      version: '0.0.1',
      supports: (s) => s.role !== 'evaluation' && s.solverType === SOLVER_TYPE,
      async run(ctx): Promise<Solution> {
        captured.runCount += 1;
        captured.task = ctx.task;
        if (captured.runCount === 1) {
          // Transient/recoverable failure — _classifyAndMarkTerminal leaves
          // the row at RUNNING for the next tick to retry (task.windowEndTs
          // is in the future and the message doesn't match any permanent
          // pattern in isRecoverableTransactionError).
          throw new Error('network error: transient hiccup');
        }
        return {
          venueRef: { name: 'flaky-capturing-stub' },
          gating: { ok: true },
          preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
          postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
          fills: [],
        };
      },
    };

    const engine = new TaskEngine(engineOpts(store, tmp, flaky));
    const querySpy = vi.spyOn(store, 'queryEnvelopeProjections');
    const p = new TaskRunPersistence(store.db);
    await engine.observe(runInput('req-know-retry'));
    p.transition('req-know-retry', TaskRunState.CLAIMED);
    p.transition('req-know-retry', TaskRunState.WAITING);

    // First attempt: harness throws, row stays at RUNNING.
    await expect(engine.process('req-know-retry')).rejects.toThrow('network error: transient hiccup');
    expect(p.getByRequestId('req-know-retry')!.state).toBe(TaskRunState.RUNNING);

    // Second attempt (the retry re-drive): succeeds.
    await engine.process('req-know-retry');
    expect(p.getByRequestId('req-know-retry')!.state).toBe(TaskRunState.POST_SNAPSHOT);

    expect(captured.runCount).toBe(2);
    // The corpus was queried exactly once across both attempts, not twice.
    expect(querySpy).toHaveBeenCalledTimes(1);
    // Both attempts saw the same injected knowledge.
    const payload = captured.task?.context?.['corpusKnowledge'] as { records: Array<{ envelopeCid: string }> };
    expect(payload.records.map((r) => r.envelopeCid)).toEqual(['env-prior-retry']);
    // Exactly one corpus_knowledge event, not one per attempt.
    const events = store.db
      .prepare(`SELECT kind FROM activity_events WHERE kind = 'corpus_knowledge' AND request_id = ?`)
      .all('req-know-retry');
    expect(events).toHaveLength(1);
  });
});

describe('#1393 pack() saves the envelope projection', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    vi.clearAllMocks();
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('a completed pack leaves a solution projection queryable by solverType', async () => {
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured)));
    const p = await driveToPostSnapshot(engine, store, 'req-proj-1');
    // Second process(): POST_SNAPSHOT → PACKAGING → real pack() (uploadToIpfs mocked).
    await engine.process('req-proj-1');
    expect(p.getByRequestId('req-proj-1')!.state).toBe(TaskRunState.DELIVERING);

    const projections = store.queryEnvelopeProjections({ solverType: SOLVER_TYPE, role: 'solution' });
    expect(projections).toHaveLength(1);
    expect(projections[0]!.envelopeCid).toBe('bafymock123'); // the mocked uploadToIpfs CID
    expect(projections[0]!.requestId).toBe('req-proj-1');
  });

  it('a second run of the same solverType sees the first run\'s projection as knowledge', async () => {
    const first: { task?: Task } = {};
    const engine1 = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(first)));
    await driveToPostSnapshot(engine1, store, 'req-chain-1');
    await engine1.process('req-chain-1'); // pack → projection saved

    const second: { task?: Task } = {};
    const engine2 = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(second)));
    await driveToPostSnapshot(engine2, store, 'req-chain-2');

    const payload = second.task?.context?.['corpusKnowledge'] as { records: Array<{ envelopeCid: string }> };
    expect(payload).toBeDefined();
    expect(payload.records.map((r) => r.envelopeCid)).toContain('bafymock123');
  });
});

describe('#1393 review finding 1 — projection evidenceTier reflects actual delivery, not sign-time intent', () => {
  let store: Store;
  let tmp: string;

  function engineOptsWithDelivery(impl: Harness): TaskEngineOptions {
    return {
      ...engineOpts(store, tmp, impl),
      deliveryDeps: {
        publicClient: {} as import('viem').PublicClient,
        walletClient: {} as import('viem').WalletClient,
        safeAddress: '0xsafe' as `0x${string}`,
        mechContractAddress: '0xmech' as `0x${string}`,
        routerAddress: '0xrouter' as `0x${string}`,
        claimDeliveryVariant: 'v2',
      },
    };
  }

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    vi.clearAllMocks();
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('pack() saves the projection as self-signed even though the v2 envelope declares committed', async () => {
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOptsWithDelivery(makeCapturingImpl(captured)));
    await driveToPostSnapshot(engine, store, 'req-tier-1');
    await engine.process('req-tier-1'); // POST_SNAPSHOT → PACKAGING → pack() → DELIVERING

    const projections = store.queryEnvelopeProjections({ solverType: SOLVER_TYPE, role: 'solution' });
    expect(projections).toHaveLength(1);
    expect(projections[0]!.evidenceTier).toBe('self-signed');
  });

  it('deliver() upgrades the projection to committed once claimDelivery actually succeeds', async () => {
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOptsWithDelivery(makeCapturingImpl(captured)));
    const p = await driveToPostSnapshot(engine, store, 'req-tier-2');
    await engine.process('req-tier-2'); // pack() → DELIVERING
    await engine.process('req-tier-2'); // deliver() → COMPLETE
    expect(p.getByRequestId('req-tier-2')!.state).toBe(TaskRunState.COMPLETE);

    const projections = store.queryEnvelopeProjections({ solverType: SOLVER_TYPE, role: 'solution' });
    expect(projections).toHaveLength(1);
    expect(projections[0]!.evidenceTier).toBe('committed');
  });

  it('a race-lost/failed delivery leaves the projection at self-signed (never mis-stamped committed)', async () => {
    vi.mocked(claimDelivery).mockRejectedValueOnce(new Error('delivery race lost'));
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOptsWithDelivery(makeCapturingImpl(captured)));
    const p = await driveToPostSnapshot(engine, store, 'req-tier-3');
    await engine.process('req-tier-3'); // pack() → DELIVERING
    await expect(engine.process('req-tier-3')).rejects.toThrow('delivery race lost');
    expect(p.getByRequestId('req-tier-3')!.state).not.toBe(TaskRunState.COMPLETE);

    const projections = store.queryEnvelopeProjections({ solverType: SOLVER_TYPE, role: 'solution' });
    expect(projections).toHaveLength(1);
    expect(projections[0]!.evidenceTier).toBe('self-signed');
  });
});
