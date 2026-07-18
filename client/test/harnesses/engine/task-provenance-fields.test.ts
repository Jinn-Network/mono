/**
 * pack() — generatorModel / distributionClass / task.createdAt / instanceId
 * end-to-end wiring (#1827).
 *
 * Setup mirrors engine-packaging.test.ts (same mocks, helpers, and
 * state-machine walk); the assertions here are only about the four new
 * envelope fields.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import { TaskEngine, type TaskEngineOptions } from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

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

function mkTmp(): string {
  const dir = join(tmpdir(), `task-prov-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeInput(requestId: string): PersistedTaskRunInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    taskCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    solverType: 'portfolio.v0',
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    task: {
      id: requestId,
      description: 'test',
      solverType: 'portfolio.v0',
      role: 'restoration',
      spec: {
        instance_id: 'astropy__astropy-12907',
        repo: 'astropy/astropy',
        base_commit: 'abc123def456',
      },
    },
  };
}

function makeOpts(store: Store, tmp: string, extra: Partial<TaskEngineOptions> = {}): TaskEngineOptions {
  return {
    store,
    paths: {
      workingDirRoot: join(tmp, 'restorations'),
      implStateDirRoot: join(tmp, 'impls'),
    },
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
    ...extra,
  };
}

class TestEngine extends TaskEngine {
  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }
}

/**
 * Walk an already-observed task through CLAIMED → … → PACKAGING, run pack()
 * via process(), and return the envelope captured by the IPFS upload mock.
 */
async function packThrough(engine: TestEngine, requestId: string, tmp: string): Promise<Record<string, unknown>> {
  const workingDir = join(tmp, 'restorations', requestId);
  mkdirSync(join(workingDir, 'sessions'), { recursive: true });
  writeFileSync(join(workingDir, 'sessions', 'session.jsonl'), '{"msg":"hi"}');
  mkdirSync(join(workingDir, 'env'), { recursive: true });
  writeFileSync(join(workingDir, 'intent.json'), '{}');

  const p = engine.testPersistence;
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  p.transition(requestId, TaskRunState.PRE_SNAPSHOT, {
    workingDir,
    implStateDir: join(tmp, 'impls', 'test'),
    preSnapshotCapturedAt: Date.now(),
    preSnapshotPayload: { equity: '1000', capturedAt: Date.now(), hlTime: 0 },
  });
  p.transition(requestId, TaskRunState.RUNNING);
  p.transition(requestId, TaskRunState.POST_SNAPSHOT, {
    postSnapshotCapturedAt: Date.now(),
    postSnapshotPayload: { equity: '1100', capturedAt: Date.now(), hlTime: 0 },
    fillsPayload: [],
    gatingClaim: { equityReturnPct: '10', maxDrawdownPct: '5', closedTradesCount: 25, tradedNotionalMultiple: '8' },
  });
  p.transition(requestId, TaskRunState.PACKAGING);

  const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
  const uploadMock = uploadToIpfs as ReturnType<typeof vi.fn>;
  uploadMock.mockResolvedValue('bafymock123');
  uploadMock.mockClear();

  await engine.process(requestId);

  const envelopeCall = uploadMock.mock.calls.find(
    ([, payload]: [string, unknown]) =>
      typeof payload === 'object' &&
      payload !== null &&
      (payload as Record<string, unknown>)['schemaVersion'] === 'jinn.execution.v1',
  );
  expect(envelopeCall).toBeDefined();
  return envelopeCall![1] as Record<string, unknown>;
}

describe('pack() — task provenance fields end-to-end (#1827)', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('populates executor.generatorModel (config source), task fields, and derives distributionClass', async () => {
    const engine = new TestEngine(makeOpts(store, tmp, {
      operatorConfig: {
        publicEndpoint: 'https://op.test',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        claudeModel: 'claude-haiku-4-5-20251001',
      },
    }));
    const requestId = 'req-provenance-1';
    await engine.observe(makeInput(requestId));
    // Simulate claim()-time resolution (covered by claim-gate.test.ts) so
    // pack() finds a persisted timestamp to thread into task.createdAt.
    engine.testPersistence.setOnchainCreationTimestamp(requestId, 1752000000);

    const envelope = await packThrough(engine, requestId, tmp);

    expect(envelope['distributionClass']).toBe('restricted-tos');
    expect((envelope['executor'] as Record<string, unknown>)['generatorModel']).toEqual({
      id: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      source: 'config',
    });
    const task = envelope['task'] as Record<string, unknown>;
    expect(task['instanceId']).toBe('astropy__astropy-12907');
    expect(task['repo']).toBe('astropy/astropy');
    expect(task['baseCommit']).toBe('abc123def456');
    expect(task['createdAt']).toBe(1752000000);
  });

  it('omits task.createdAt when never resolved; distributionClass "unknown" without a model', async () => {
    const engine = new TestEngine(makeOpts(store, tmp)); // no operatorConfig → no model anywhere
    const requestId = 'req-provenance-2';
    await engine.observe(makeInput(requestId));

    const envelope = await packThrough(engine, requestId, tmp);

    const task = envelope['task'] as Record<string, unknown>;
    expect(task['createdAt']).toBeUndefined();
    // Spec-derived identity still present regardless of timestamp resolution.
    expect(task['instanceId']).toBe('astropy__astropy-12907');
    // No model anywhere → generatorModel degrades to id:'unknown', and the
    // derived class must be 'unknown' (never a fabricated 'open').
    expect((envelope['executor'] as Record<string, unknown>)['generatorModel']).toEqual({ id: 'unknown', source: 'config' });
    expect(envelope['distributionClass']).toBe('unknown');
  });
});
