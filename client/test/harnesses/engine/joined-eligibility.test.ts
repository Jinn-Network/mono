// Per-launch operator-eligibility filter (Task 28 of
// `spec/2026-05-05-solvernet-creation-and-launch.md` §14).
//
// The operator's claim path filters tasks by manifest-bound
// `manifestDigest = keccak256(solverNetManifestCid)`. An operator who
// joined Launcher A's Prediction is NOT automatically eligible to claim
// Launcher B's Prediction tasks even though both share the same SolverNet
// contract — the on-chain digests differ because the off-chain manifest
// CIDs differ.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes } from 'viem';

import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  joinedSolverNetsViewFromConfig,
  createMutableJoinedSolverNetsView,
  type JoinedSolverNetsView,
} from '../../../src/harnesses/engine/engine.js';
import type { PersistedTaskRun } from '../../../src/harnesses/engine/persistence.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import { getSolverNetContract } from '../../../src/solver-nets/contracts.js';
import { SolverNetRegistry } from '../../../src/solver-nets/registry.js';
import type { Task } from '../../../src/types/task.js';
import {
  makePredictionV1Task,
  TEST_PREDICTION_V1_MANIFEST_CID,
} from '../impls/prediction-v1-test-helpers.js';
import {
  buildPredictionV1ManifestStub,
  buildSweRebenchV2ManifestStub,
  makeStubManifestResolver,
} from './manifest-resolver-stub.js';

// Two distinct launcher manifest CIDs sharing the same SolverNet contract
// (prediction.v1). The operator-side eligibility filter must distinguish
// them by `manifestDigest = keccak256(cid)`.
const LAUNCHER_A_CID = TEST_PREDICTION_V1_MANIFEST_CID;
const LAUNCHER_B_CID = 'bafy-prediction-v1-launcher-b-test';
const SWE_REBENCH_CID = 'bafy-swe-rebench-v2-test-manifest';

function stubHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    name: 'prediction-v1-test-harness',
    version: '1.0.0',
    supports: ({ solverType }) => solverType === 'prediction.v1',
    run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
    ...overrides,
  };
}

function fixtureSolverNetRegistry(): SolverNetRegistry {
  const registry = new SolverNetRegistry();
  const predictionContract = getSolverNetContract({ id: 'prediction', version: 'v1' });
  const sweContract = getSolverNetContract({ id: 'swe-rebench-v2', version: 'v1' });
  if (!predictionContract || !sweContract) throw new Error('fixture SolverNet contract missing');

  for (const manifestCid of [LAUNCHER_A_CID, LAUNCHER_B_CID]) {
    registry.register({
      name: manifestCid,
      manifestCid,
      enabled: true,
      solverType: 'prediction.v1',
      roles: ['solving', 'evaluating'],
      contract: predictionContract,
      harness: 'prediction-v1-test-harness',
      runtimePlugins: [],
      taskGenerator: { enabled: false },
    });
  }
  registry.register({
    name: SWE_REBENCH_CID,
    manifestCid: SWE_REBENCH_CID,
    enabled: true,
    solverType: 'swe-rebench-v2.v1',
    roles: ['solving'],
    contract: sweContract,
    harness: 'prediction-v1-test-harness',
    runtimePlugins: [],
    taskGenerator: { enabled: false },
  });
  return registry;
}

describe('Task 28 — joinedSolverNets manifestDigest eligibility filter', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-joined-eligibility-'));
    store = new Store(join(dir, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  class TestEngine extends TaskEngine {
    async callClaim(intent: PersistedTaskRun): Promise<void> {
      return this.claim(intent);
    }
    get db(): import('../../../src/harnesses/engine/persistence.js').TaskRunPersistence {
      return this.persistence;
    }
  }

  function makeEngine(opts: {
    joinedSolverNets?: JoinedSolverNetsView;
    canAttempt?: (task: Task) => Promise<{ ok: true } | { ok: false; reason: string }>;
  } = {}): TestEngine {
    const canAttempt = opts.canAttempt ?? (async () => ({ ok: true as const }));
    // Both launcher A and B share the same prediction.v1 contract, so the
    // manifest resolver must resolve both CIDs.
    const manifestResolver = makeStubManifestResolver({
      [LAUNCHER_B_CID]: buildPredictionV1ManifestStub({
        solverNetId: 'prediction-v1-launcher-b',
        name: 'Prediction (launcher B)',
      }),
      [SWE_REBENCH_CID]: buildSweRebenchV2ManifestStub(),
    });
    return new TestEngine({
      store,
      paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl-state') },
      implRegistry: { findFor: () => stubHarness({ canAttempt }) },
      solverNetRegistry: fixtureSolverNetRegistry(),
      manifestResolver,
      ...(opts.joinedSolverNets ? { joinedSolverNets: opts.joinedSolverNets } : {}),
    });
  }

  // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
  // Task 16): canAcceptTask({ taskRole: 'restoration', ... }) is now always refused
  // before the joined-eligibility filter runs (see
  // test/daemon/solution-path-retired.test.ts). The filter itself
  // (TaskEngine.evaluateJoinedEligibility) is unchanged and role-agnostic, and stays
  // live for restoration through the surviving claim() entry point (DISCOVERED →
  // CLAIMED), which runs the identical runnableFailureReason check. This suite's
  // restoration-role ('solver') probes now go through claim() instead of
  // canAcceptTask so they keep exercising the real, still-load-bearing code path
  // rather than the (now-constant) canAcceptTask(restoration) refusal.
  let claimProbeSeq = 0;
  async function acceptRestorationViaClaim(
    engine: TestEngine,
    task: Task,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const requestId = `${task.id ?? 'claim-probe'}-${++claimProbeSeq}`;
    const now = Date.now();
    engine.db.insertDiscovered({
      requestId,
      taskCid: `bafy-${requestId}`,
      onchainCreationTx: `0x${'ab'.repeat(32)}`,
      onchainCreationBlock: 1,
      solverType: task.solverType,
      taskRole: 'restoration',
      windowStartTs: task.window?.startTs ?? now - 1_000,
      windowEndTs: task.window?.endTs ?? now + 60_000,
      task: { ...task, id: requestId },
    });
    try {
      await engine.callClaim(engine.db.getByRequestId(requestId)!);
      return { ok: true };
    } catch (err) {
      const row = engine.db.getByRequestId(requestId)!;
      return {
        ok: false,
        reason: row.failureReason ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  describe('manifestCid present on task body (preferred path)', () => {
    it('accepts a task whose CID matches a joined SolverNet (solver role)', async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });
      const task = makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID });

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept).toEqual({ ok: true });
    });

    it("rejects Launcher B's Prediction task when operator only joined Launcher A's Prediction", async () => {
      // The headline scenario from the spec: same SolverNet contract,
      // different launchers, different manifestCids → different digests.
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });
      const task = makePredictionV1Task({ solverNetManifestCid: LAUNCHER_B_CID });

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/has not joined that SolverNet/);
        expect(accept.reason).toContain(LAUNCHER_B_CID);
      }
    });

    it("rejects evaluation task when operator joined for 'solver' but not 'evaluator'", async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID }),
        role: 'evaluation',
      };

      const accept = await engine.canAcceptTask({ taskRole: 'evaluation', task });

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/did not opt into role 'evaluator'/);
      }
    });

    it("accepts evaluation task when operator joined as evaluator", async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['evaluator'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID }),
        role: 'evaluation',
      };

      const accept = await engine.canAcceptTask({ taskRole: 'evaluation', task });

      expect(accept).toEqual({ ok: true });
    });

    it("rejects restoration task when operator only joined as 'evaluator'", async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['evaluator'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });
      const task = makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID });

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/did not opt into role 'solver'/);
      }
    });

    it('accepts both roles when joined entry lists both', async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver', 'evaluator'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });

      const restoration = await acceptRestorationViaClaim(
        engine,
        makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID }),
      );
      expect(restoration).toEqual({ ok: true });

      const evaluation = await engine.canAcceptTask({
        taskRole: 'evaluation',
        task: {
          ...makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID }),
          role: 'evaluation',
        } as Task,
      });
      expect(evaluation).toEqual({ ok: true });
    });

    it('validates swe-rebench-v2 task.spec payloads against the manifest contract schema', async () => {
      const view = joinedSolverNetsViewFromConfig({
        [SWE_REBENCH_CID]: { manifestCid: SWE_REBENCH_CID, roles: ['solver'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });
      const task: Task = {
        id: 'swe-rebench-task',
        description: 'SWE-rebench v2: example__repo-1',
        solverType: 'swe-rebench-v2.v1',
        contractId: 'swe-rebench-v2',
        contractVersion: 'v1',
        solverNetManifestCid: SWE_REBENCH_CID,
        role: 'restoration',
        window: {
          startTs: Date.parse('2026-05-02T00:00:00.000Z'),
          endTs: Date.parse('2026-05-09T00:00:00.000Z'),
        },
        spec: {
          schemaVersion: 'swe-rebench-v2.v1',
          instance_id: 'example__repo-1',
          repo: 'example/repo',
          base_commit: '0123456789abcdef0123456789abcdef01234567',
          language: 'python',
          problem_statement: 'Fix the bug.',
          interface: '',
          hf_dataset: 'nebius/SWE-rebench-leaderboard',
          hf_split: '2026_02',
          deadline_unix: 1778284800,
          round_month: '2026-02',
        },
        eligibility: {},
      };

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept).toEqual({ ok: true });
    });

    it('rejects every task when operator has joined nothing', async () => {
      const view = joinedSolverNetsViewFromConfig({});
      const engine = makeEngine({ joinedSolverNets: view });
      const task = makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID });

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/has not joined that SolverNet/);
      }
    });

    it('disambiguates two joined launchers', async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
        [LAUNCHER_B_CID]: { manifestCid: LAUNCHER_B_CID, roles: ['evaluator'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });

      // Launcher A: solver role accepted.
      const acceptA = await acceptRestorationViaClaim(
        engine,
        makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID }),
      );
      expect(acceptA).toEqual({ ok: true });

      // Launcher A: evaluator role rejected (not joined for evaluator on A).
      const evalA = await engine.canAcceptTask({
        taskRole: 'evaluation',
        task: {
          ...makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID }),
          role: 'evaluation',
        } as Task,
      });
      expect(evalA.ok).toBe(false);
      if (!evalA.ok) {
        expect(evalA.reason).toMatch(/did not opt into role 'evaluator'/);
      }

      // Launcher B: evaluator role accepted.
      const evalB = await engine.canAcceptTask({
        taskRole: 'evaluation',
        task: {
          ...makePredictionV1Task({ solverNetManifestCid: LAUNCHER_B_CID }),
          role: 'evaluation',
        } as Task,
      });
      expect(evalB).toEqual({ ok: true });

      // Launcher B: solver role rejected (not joined for solver on B).
      const solveB = await acceptRestorationViaClaim(
        engine,
        makePredictionV1Task({ solverNetManifestCid: LAUNCHER_B_CID }),
      );
      expect(solveB.ok).toBe(false);
      if (!solveB.ok) {
        expect(solveB.reason).toMatch(/did not opt into role 'solver'/);
      }
    });
  });

  describe('manifestDigest fallback (on-chain-only discovery)', () => {
    // The watcher path may discover a task by on-chain event before
    // fetching the IPFS body. In that scenario the runtime Task carries
    // `manifestDigest` (bytes32) but no `solverNetManifestCid`. The
    // engine must compute keccak256 of every joined CID to find a match.

    it('accepts a task whose digest matches a joined CID', async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });

      // Construct a Task with on-chain digest only (no CID body).
      const expectedDigest = keccak256(toBytes(LAUNCHER_A_CID));
      const task = {
        id: 'digest-only-task',
        description: 'Discovered via on-chain event before IPFS fetch.',
        manifestDigest: expectedDigest,
        contractId: 'prediction',
        contractVersion: 'v1',
      } as unknown as Task;

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept).toEqual({ ok: true });
    });

    it("rejects a task whose digest doesn't match any joined CID", async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });

      const otherDigest = keccak256(toBytes(LAUNCHER_B_CID));
      const task = {
        id: 'digest-only-task',
        description: 'Another launcher posted this — operator hasn\'t joined.',
        manifestDigest: otherDigest,
      } as unknown as Task;

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/manifestDigest/);
        expect(accept.reason).toMatch(/does not match any joined SolverNet/);
      }
    });

    it('rejects digest match when operator did not opt into the required role', async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['evaluator'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });

      const expectedDigest = keccak256(toBytes(LAUNCHER_A_CID));
      const task = {
        id: 'digest-only-task',
        description: 'Restoration task posted by Launcher A.',
        manifestDigest: expectedDigest,
        role: 'restoration',
      } as unknown as Task;

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/did not opt into role 'solver'/);
      }
    });

    it('does not fail tasks with neither CID nor digest (legacy / health-check shape)', async () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
      });
      const engine = makeEngine({ joinedSolverNets: view });

      // Health-check style task — no manifest binding at all. The Task 28
      // filter is a no-op; downstream gates (solverType / harness) take over.
      const task: Task = {
        id: 'health-check',
        description: 'health check',
      };

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept).toEqual({ ok: true });
    });
  });

  describe('#1037 — always-constructed mutable empty view (zero-join daemon)', () => {
    // main.ts now ALWAYS wires the engine view (a mutable empty one at zero
    // joins) instead of leaving it undefined. This flips a zero-join daemon
    // from the legacy solverType fallback to an active (empty) joined gate.
    // Safe because the daemon's discovery cid set is also empty (it discovers
    // nothing), and no-cid/no-digest tasks still fall through to legacy gates.
    it('rejects a cid-bearing task under an empty mutable view', async () => {
      const view = createMutableJoinedSolverNetsView({});
      const engine = makeEngine({ joinedSolverNets: view });
      const task = makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID });

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/has not joined that SolverNet/);
      }
    });

    it('passes a task with neither cid nor digest under an empty mutable view', async () => {
      const view = createMutableJoinedSolverNetsView({});
      const engine = makeEngine({ joinedSolverNets: view });
      const task: Task = { id: 'health-check', description: 'health check' };

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept).toEqual({ ok: true });
    });

    it('accepts a cid-bearing task after the join is set() live', async () => {
      const view = createMutableJoinedSolverNetsView({});
      const engine = makeEngine({ joinedSolverNets: view });
      const task = makePredictionV1Task({ solverNetManifestCid: LAUNCHER_A_CID });

      const before = await acceptRestorationViaClaim(engine, task);
      expect(before.ok).toBe(false);

      view.set(LAUNCHER_A_CID, { roles: ['solver'] });

      const after = await acceptRestorationViaClaim(engine, task);
      expect(after).toEqual({ ok: true });
    });
  });

  describe('legacy / no-view path', () => {
    it('preserves solverType fallback for a no-CID health-check when no view is wired', async () => {
      // Engine without joinedSolverNets — preserves existing test behaviour
      // for legacy health checks that don't exercise per-launch attribution.
      const engine = makeEngine({});
      const task = {
        ...makePredictionV1Task(),
        solverNetManifestCid: undefined,
      } as unknown as Task;

      const accept = await acceptRestorationViaClaim(engine, task);

      // No manifest binding → falls through to the legacy solverType path.
      expect(accept).toEqual({ ok: true });
    });
  });

  describe('joinedSolverNetsViewFromConfig helper', () => {
    it('returns undefined when config block is absent', () => {
      expect(joinedSolverNetsViewFromConfig(undefined)).toBeUndefined();
    });

    it('preserves manifestCid → roles mapping', () => {
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver', 'evaluator'] },
      });
      expect(view).toBeDefined();
      expect(view!.manifestCids()).toEqual([LAUNCHER_A_CID]);
      expect(view!.get(LAUNCHER_A_CID)).toEqual({ roles: ['solver', 'evaluator'] });
      expect(view!.get('unknown-cid')).toBeUndefined();
    });

    it('falls back to the entry.manifestCid field when the key disagrees', () => {
      // Defensive — the spec requires keys to match `manifestCid`, but if a
      // future config schema diverged (e.g., name-keyed) the helper should
      // still index by the binding CID.
      const view = joinedSolverNetsViewFromConfig({
        someOtherKey: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
      });
      expect(view!.manifestCids()).toEqual([LAUNCHER_A_CID]);
      expect(view!.get(LAUNCHER_A_CID)).toEqual({ roles: ['solver'] });
    });
  });

  describe('runs before downstream harness/canAttempt checks', () => {
    it('skips harness canAttempt() when manifestCid is not joined', async () => {
      const canAttempt = vi.fn(async () => ({ ok: true as const }));
      const view = joinedSolverNetsViewFromConfig({
        [LAUNCHER_A_CID]: { manifestCid: LAUNCHER_A_CID, roles: ['solver'] },
      });
      const engine = makeEngine({ joinedSolverNets: view, canAttempt });
      const task = makePredictionV1Task({ solverNetManifestCid: LAUNCHER_B_CID });

      const accept = await acceptRestorationViaClaim(engine, task);

      expect(accept.ok).toBe(false);
      // Eligibility short-circuit must run before the harness gate.
      expect(canAttempt).not.toHaveBeenCalled();
    });
  });
});
