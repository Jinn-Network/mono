/**
 * The load-bearing pin for Task 16 (cutover stage 1 —
 * docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md): the TaskEngine evaluation
 * path must stay behaviourally identical while the solution path retires. See
 * `test/daemon/solution-path-retired.test.ts` for the retirement-side coverage.
 *
 * This file exercises `canAcceptTask({ taskRole: 'evaluation', ... })` through every branch of
 * `TaskEngine.runnableFailureReason` reachable from the engine-watcher hot path (canAcceptTask
 * always sets `skipReadinessProbe: true`, so the `impl.isReady()` branch is never reached from
 * this entry point — see claim-gate.test.ts's "canAcceptTask — issue #398" suite, which already
 * pins that), plus a full DISCOVERED -> COMPLETE run through the real `TaskEngine` (claim(),
 * takePreSnapshot(), runImpl(), pack(), deliver() all run for real — only the chain/IPFS I/O
 * leaves are mocked, matching this repo's MOCK_JUSTIFICATION convention).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { TaskEngine, joinedSolverNetsViewFromConfig } from '../../src/harnesses/engine/engine.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../src/harnesses/engine/state.js';
import type { Harness, ReadyStatus, Solution } from '../../src/harnesses/types.js';
import type { Task } from '../../src/types/task.js';
import { engineFixture, evaluationTask } from './_engine-fixtures.js';

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking
// it is mocking the boundary (matches test/harnesses/engine/engine-packaging.test.ts's own
// convention for a full pack()/deliver() run). callDeliverToMarketplace resolves a real 32-byte
// hex string here (not the '0xdeliverytx' placeholder engine-packaging.test.ts uses) because this
// file's regression test asserts the production deliveryTxHash shape.
vi.mock('../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`),
  claimDelivery: vi.fn().mockResolvedValue(`0x${'ef'.repeat(32)}`),
  submitTask: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  decodeTaskCreatedLogs: vi.fn().mockReturnValue([]),
  decodeSolutionDeliveryClaimedLogs: vi.fn().mockReturnValue([]),
  scanTasks: vi.fn(),
  scanEvaluationJobs: vi.fn(),
  canClaimTask: vi.fn(),
  canClaimEvaluation: vi.fn(),
  claimTask: vi.fn(),
  claimEvaluation: vi.fn(),
  findLatestDeliveryDataHexForRequest: vi.fn(),
  getMarketplaceRequestDeliveryMech: vi.fn(),
  getTaskCidDigest: vi.fn(),
  findLatestDeliveryForRequest: vi.fn(),
  isDeliveryAlreadyClaimed: vi.fn().mockResolvedValue(false),
}));

// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls;
// pack() calls uploadToIpfs directly — without this mock it would attempt a real HTTP POST.
vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(`0x${'de'.repeat(32)}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  fetchSignedTaskFromIpfs: vi.fn(),
  fetchSignedEnvelopeFromIpfs: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

describe('evaluation path is untouched at stage 1', () => {
  it('still accepts an evaluation task', async () => {
    const engine = engineFixture();
    await expect(
      engine.canAcceptTask({ solverType: 'prediction.v1', taskRole: 'evaluation', task: evaluationTask() }),
    ).resolves.toEqual({ ok: true });
  });

  it('still runs an evaluation DISCOVERED → COMPLETE and claims the verdict delivery', async () => {
    const store = new Store(':memory:');
    const engine = engineFixture({ store });
    const requestId = await engine.observe(evaluationTask());
    await engine.process(requestId);
    const row = new TaskRunPersistence(store.db).getOrThrow(requestId);
    expect(row.state).toBe('COMPLETE');
    expect(row.taskRole).toBe('evaluation');
    expect(row.deliveryTxHash).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it('still parses a bridged converged Delivery into restorationResult', async () => {
    const engine = engineFixture();
    const task = evaluationTask({ bridged: true });
    expect(task.context?.restorationResult).toBe('legacy restoration result payload');
    await expect(
      engine.canAcceptTask({ solverType: 'prediction.v1', taskRole: 'evaluation', task }),
    ).resolves.toEqual({ ok: true });
  });
});

// ── Every branch of canAcceptTask({ taskRole: 'evaluation', ... }) ────────────
//
// canAcceptTask({ taskRole: 'restoration', ... }) is retired at Task 16 (see
// solution-path-retired.test.ts): it now short-circuits to a fixed refusal before any of the
// checks below run. For taskRole 'evaluation' the new code adds nothing — the early-return only
// triggers on 'restoration' — so every branch of the pre-existing eligibility pipeline
// (`TaskEngine.runnableFailureReason`) must still fire exactly as before. This suite is the
// direct evidence for that claim: it does not reuse engineFixture (which wires
// packagingDeps/envelopeDeps/deliveryDeps for the full-run tests above) because these are
// pure canAcceptTask branch probes — lightweight TaskEngine construction, mirroring
// test/harnesses/engine/claim-gate.test.ts and test/harnesses/engine/joined-eligibility.test.ts.
describe('canAcceptTask(evaluation) — every runnableFailureReason branch', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-eval-branches-'));
    store = new Store(join(dir, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function paths() {
    return { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl') };
  }

  function stubHarness(overrides: Partial<Harness> = {}): Harness {
    return {
      name: 'stub-harness',
      version: '1.0.0',
      supports: () => true,
      run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: { verdict: 'PASS' } }),
      ...overrides,
    };
  }

  function evalTask(overrides: Partial<Task> = {}): Task {
    return {
      id: 'eval-task-1',
      description: 'test',
      solverType: 'prediction.v1',
      role: 'evaluation',
      window: { startTs: Date.now() - 1_000, endTs: Date.now() + 60_000 },
      ...overrides,
    };
  }

  it('success: resolves ok:true with no gating configured', async () => {
    const engine = new TaskEngine({ store, paths: paths() });
    await expect(
      engine.canAcceptTask({ taskRole: 'evaluation', task: evalTask() }),
    ).resolves.toEqual({ ok: true });
  });

  it('joinedSolverNets: rejects when the operator did not join the evaluator role', async () => {
    const cid = 'bafy-eval-branch-joined';
    const view = joinedSolverNetsViewFromConfig({
      [cid]: { manifestCid: cid, roles: ['solver'] },
    });
    const engine = new TaskEngine({ store, paths: paths(), joinedSolverNets: view });
    const accept = await engine.canAcceptTask({
      taskRole: 'evaluation',
      task: evalTask({ solverNetManifestCid: cid }),
    });
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.reason).toMatch(/did not opt into role 'evaluator'/);
  });

  it('joinedSolverNets: accepts when the operator joined as evaluator', async () => {
    const cid = 'bafy-eval-branch-joined-ok';
    const view = joinedSolverNetsViewFromConfig({
      [cid]: { manifestCid: cid, roles: ['evaluator'] },
    });
    const engine = new TaskEngine({ store, paths: paths(), joinedSolverNets: view });
    const accept = await engine.canAcceptTask({
      taskRole: 'evaluation',
      task: evalTask({ solverNetManifestCid: cid }),
    });
    expect(accept).toEqual({ ok: true });
  });

  it('in-flight gate: refuses a second evaluation task while one is in flight for the same solverType', async () => {
    const engine = new TaskEngine({ store, paths: paths() });
    const now = Date.now();
    new TaskRunPersistence(store.db).insertDiscovered({
      requestId: 'active-eval',
      taskCid: 'bafy-active',
      onchainCreationTx: '0xactive',
      onchainCreationBlock: 1,
      solverType: 'prediction.v1',
      taskRole: 'evaluation',
      windowStartTs: now + 1_000,
      windowEndTs: now + 60_000,
      task: evalTask({ id: 'active-eval' }),
    });
    const accept = await engine.canAcceptTask({
      solverType: 'prediction.v1',
      taskRole: 'evaluation',
      task: evalTask({ id: 'next-eval' }),
    });
    expect(accept).toEqual({
      ok: false,
      reason: 'another prediction.v1/evaluation task is already in flight',
    });
  });

  it('no enabled SolverNet: refuses when a solverNetRegistry is wired but has no entry for this solverType/role', async () => {
    const engine = new TaskEngine({
      store,
      paths: paths(),
      solverNetRegistry: { forSolverType: () => undefined },
    });
    const accept = await engine.canAcceptTask({
      solverType: 'prediction.v1',
      taskRole: 'evaluation',
      task: evalTask(),
    });
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.reason).toMatch(/no enabled SolverNet/);
  });

  it('no Harness registered: refuses when implRegistry.findFor returns undefined', async () => {
    const engine = new TaskEngine({
      store,
      paths: paths(),
      implRegistry: { findFor: () => undefined },
    });
    const accept = await engine.canAcceptTask({
      solverType: 'prediction.v1',
      taskRole: 'evaluation',
      task: evalTask(),
    });
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.reason).toMatch(/no Harness registered or enabled/);
  });

  it('impl.canAttempt: refuses when the resolved Harness declines the task', async () => {
    const engine = new TaskEngine({
      store,
      paths: paths(),
      implRegistry: {
        findFor: () => stubHarness({
          canAttempt: async () => ({ ok: false, reason: 'evaluator declines: stale market' }),
        }),
      },
    });
    const accept = await engine.canAcceptTask({
      solverType: 'prediction.v1',
      taskRole: 'evaluation',
      task: evalTask(),
    });
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.reason).toMatch(/evaluator declines: stale market/);
  });

  it('does NOT probe impl.isReady() — the readiness gate is downstream (issue #398), unchanged for evaluation', async () => {
    const isReady = vi.fn(async () => ({ ready: false, reason: 'would block if probed' }) as ReadyStatus);
    const engine = new TaskEngine({
      store,
      paths: paths(),
      implRegistry: { findFor: () => stubHarness({ isReady }) },
    });
    const accept = await engine.canAcceptTask({
      solverType: 'prediction.v1',
      taskRole: 'evaluation',
      task: evalTask(),
    });
    expect(accept).toEqual({ ok: true });
    expect(isReady).not.toHaveBeenCalled();
  });
});
