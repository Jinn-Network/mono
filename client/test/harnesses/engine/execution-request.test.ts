// Issue #2039 — pin an ordinary task to an exact execution profile.
//
// AC2: with two joined SolverNets for the same solver type, the engine
//      selects the requested manifest CID rather than registry order.
// AC3: before claim or model invocation, unsupported manifest/role/harness/
//      version/model combinations are rejected.
// AC4: existing tasks without an execution request retain their current
//      behavior.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  joinedSolverNetsViewFromConfig,
  type JoinedSolverNetsView,
  type ManifestResolver,
  type SolverNetRegistryLike,
} from '../../../src/harnesses/engine/engine.js';
import { HarnessRegistry } from '../../../src/harnesses/engine/registry.js';
import { TaskRunPersistence } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { SolverNetRegistry, registerJoinedNet } from '../../../src/solver-nets/registry.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import type { Task } from '../../../src/types/task.js';
import { makeIntentInput } from '@test/engine.js';
import { makePredictionV1Task } from '../impls/prediction-v1-test-helpers.js';
import { buildPredictionV1ManifestStub, makeStubManifestResolver } from './manifest-resolver-stub.js';

const CID_A = 'bafy-prediction-v1-execution-request-a';
const CID_B = 'bafy-prediction-v1-execution-request-b';

function stubHarness(name: string, version: string, canAttempt: Harness['canAttempt']): Harness {
  return {
    name,
    version,
    supports: ({ solverType }) => solverType === 'prediction.v1',
    canAttempt,
    run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
  };
}

describe('execution request (issue #2039)', () => {
  let dir: string;
  let store: Store;
  let codexCanAttempt: ReturnType<typeof vi.fn>;
  let claudeCanAttempt: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-execution-request-'));
    store = new Store(join(dir, 'jinn.db'));
    codexCanAttempt = vi.fn(async () => ({ ok: true as const }));
    claudeCanAttempt = vi.fn(async () => ({ ok: true as const }));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeImplRegistry(): HarnessRegistry {
    const implRegistry = new HarnessRegistry();
    // Registered first: registry-order (solverType-only) dispatch would pick
    // this one by default for `prediction.v1`, which is exactly the bug AC2
    // guards against.
    implRegistry.register(stubHarness('codex', '1.0.0', codexCanAttempt));
    implRegistry.register(stubHarness('claude-code', '2.0.0', claudeCanAttempt));
    return implRegistry;
  }

  function buildEngine(opts: {
    implRegistry?: HarnessRegistry;
    solverNetRegistry?: SolverNetRegistryLike;
    manifestResolver: ManifestResolver;
    joinedSolverNets?: JoinedSolverNetsView;
  }): TaskEngine {
    return new TaskEngine({
      store,
      paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl-state') },
      implRegistry: opts.implRegistry ?? makeImplRegistry(),
      manifestResolver: opts.manifestResolver,
      ...(opts.solverNetRegistry ? { solverNetRegistry: opts.solverNetRegistry } : {}),
      ...(opts.joinedSolverNets ? { joinedSolverNets: opts.joinedSolverNets } : {}),
    });
  }

  async function makeEngine(): Promise<TaskEngine> {
    const solverNetRegistry = new SolverNetRegistry();
    // CID_A registered first, same solverType as CID_B, DIFFERENT harness/model.
    await registerJoinedNet(solverNetRegistry, CID_A, {
      manifestCid: CID_A,
      contract: { id: 'prediction', version: 'v1' },
      roles: ['solver'],
      harness: 'codex',
      model: 'gpt-5-codex',
      plugins: [],
    });
    await registerJoinedNet(solverNetRegistry, CID_B, {
      manifestCid: CID_B,
      contract: { id: 'prediction', version: 'v1' },
      roles: ['solver'],
      harness: 'claude-code',
      model: 'claude-sonnet-5',
      plugins: [],
    });

    const joinedSolverNets = joinedSolverNetsViewFromConfig({
      [CID_A]: { manifestCid: CID_A, roles: ['solver'] },
      [CID_B]: { manifestCid: CID_B, roles: ['solver'] },
    });

    const manifestResolver = makeStubManifestResolver({
      [CID_A]: buildPredictionV1ManifestStub({ solverNetId: 'prediction-v1-a', name: 'Prediction (A)' }),
      [CID_B]: buildPredictionV1ManifestStub({ solverNetId: 'prediction-v1-b', name: 'Prediction (B)' }),
    });

    return buildEngine({
      solverNetRegistry,
      manifestResolver,
      ...(joinedSolverNets ? { joinedSolverNets } : {}),
    });
  }

  describe('AC2 — manifest CID selection over registry order', () => {
    it('dispatches to the Harness configured on the pinned manifest, not the registry-order default', async () => {
      const engine = await makeEngine();
      const task = makePredictionV1Task({ solverNetManifestCid: CID_B });

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept).toEqual({ ok: true });
      expect(claudeCanAttempt).toHaveBeenCalledTimes(1);
      expect(codexCanAttempt).not.toHaveBeenCalled();
    });

    it('dispatches to the other net when pinned to the other manifest CID', async () => {
      const engine = await makeEngine();
      const task = makePredictionV1Task({ solverNetManifestCid: CID_A });

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept).toEqual({ ok: true });
      expect(codexCanAttempt).toHaveBeenCalledTimes(1);
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

    it('rejects an unknown exact manifest instead of falling back to another same-type net', async () => {
      const missingCid = 'bafy-prediction-v1-execution-request-missing';
      const solverNetRegistry = new SolverNetRegistry();
      await registerJoinedNet(solverNetRegistry, CID_A, {
        manifestCid: CID_A,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'codex',
        plugins: [],
      });
      const engine = buildEngine({
        solverNetRegistry,
        manifestResolver: makeStubManifestResolver({
          [missingCid]: buildPredictionV1ManifestStub(),
        }),
      });
      const task = makePredictionV1Task({ solverNetManifestCid: missingCid });
      expect(task.executionRequest).toBeUndefined();

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      expect(codexCanAttempt).not.toHaveBeenCalled();
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

    it('rejects an exact manifest lacking the requested role instead of using another eligible net', async () => {
      const solverNetRegistry = new SolverNetRegistry();
      await registerJoinedNet(solverNetRegistry, CID_A, {
        manifestCid: CID_A,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['evaluator'],
        harness: 'codex',
        plugins: [],
      });
      await registerJoinedNet(solverNetRegistry, CID_B, {
        manifestCid: CID_B,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code',
        plugins: [],
      });
      const engine = buildEngine({
        solverNetRegistry,
        manifestResolver: makeStubManifestResolver({
          [CID_A]: buildPredictionV1ManifestStub(),
        }),
      });
      const task = makePredictionV1Task({ solverNetManifestCid: CID_A });
      expect(task.executionRequest).toBeUndefined();

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      expect(codexCanAttempt).not.toHaveBeenCalled();
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

    it('rejects an exact manifest whose registered solver type disagrees with the task', async () => {
      const solverNetRegistry = new SolverNetRegistry();
      await registerJoinedNet(solverNetRegistry, CID_A, {
        manifestCid: CID_A,
        contract: { id: 'swe-rebench-v2', version: 'v1' },
        roles: ['solver'],
        harness: 'codex',
        plugins: [],
      });
      await registerJoinedNet(solverNetRegistry, CID_B, {
        manifestCid: CID_B,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code',
        plugins: [],
      });
      const engine = buildEngine({
        solverNetRegistry,
        manifestResolver: makeStubManifestResolver({
          [CID_A]: buildPredictionV1ManifestStub(),
        }),
      });
      const task = makePredictionV1Task({ solverNetManifestCid: CID_A });
      expect(task.executionRequest).toBeUndefined();

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      expect(codexCanAttempt).not.toHaveBeenCalled();
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

    it('rejects a manifest-bound task when the registry lacks exact-CID lookup', async () => {
      const solverNetRegistry = new SolverNetRegistry();
      await registerJoinedNet(solverNetRegistry, CID_A, {
        manifestCid: CID_A,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'codex',
        plugins: [],
      });
      const legacyRegistry: SolverNetRegistryLike = {
        forSolverType: solverNetRegistry.forSolverType.bind(solverNetRegistry),
      };
      const engine = buildEngine({
        solverNetRegistry: legacyRegistry,
        manifestResolver: makeStubManifestResolver({
          [CID_A]: buildPredictionV1ManifestStub(),
        }),
      });
      const task = makePredictionV1Task({ solverNetManifestCid: CID_A });
      expect(task.executionRequest).toBeUndefined();

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      expect(codexCanAttempt).not.toHaveBeenCalled();
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

  });

  describe('AC3 — unsupported execution-request combinations are rejected', () => {
    it('rejects an execution request when no SolverNet registry is wired', async () => {
      const engine = buildEngine({
        manifestResolver: makeStubManifestResolver({
          [CID_A]: buildPredictionV1ManifestStub(),
        }),
      });
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_A }),
        executionRequest: { harness: 'codex' },
      };

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      expect(codexCanAttempt).not.toHaveBeenCalled();
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

    it('rejects an execution request that lacks solverNetManifestCid', async () => {
      const engine = await makeEngine();
      const { solverNetManifestCid: _drop, ...rest } = makePredictionV1Task({
        solverNetManifestCid: CID_A,
      });
      const task = {
        ...rest,
        executionRequest: { harness: 'codex' },
      } as Task;

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/execution request requires solverNetManifestCid/);
      }
      expect(codexCanAttempt).not.toHaveBeenCalled();
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

    it('rejects a mismatched execution request during RUNNING dispatch before Harness.run', async () => {
      const runCalled = vi.fn();
      const implRegistry = new HarnessRegistry();
      implRegistry.register({
        name: 'claude-code',
        version: '1.0.0',
        supports: ({ solverType }) => solverType === 'prediction.v1',
        canAttempt: async () => ({ ok: true as const }),
        run: async (): Promise<Solution> => {
          runCalled();
          return { venueRef: { name: 'stub' }, gating: {} };
        },
      });

      const solverNetRegistry = new SolverNetRegistry();
      await registerJoinedNet(solverNetRegistry, CID_B, {
        manifestCid: CID_B,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code',
        model: 'claude-sonnet-5',
        plugins: [],
      });

      const engine = buildEngine({
        implRegistry,
        solverNetRegistry,
        manifestResolver: makeStubManifestResolver({
          [CID_B]: buildPredictionV1ManifestStub({ solverNetId: 'prediction-v1-b', name: 'Prediction (B)' }),
        }),
      });

      const requestId = 'running-exec-request-mismatch';
      const now = Date.now();
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_B }),
        // Pin a harness version that does not match the registered Harness —
        // claim would reject this, but RUNNING recovery/re-drive skips claim.
        executionRequest: { version: '2.0.0' },
      };
      await engine.observe(makeIntentInput({
        requestId,
        solverType: 'prediction.v1',
        windowStartTs: now - 1000,
        windowEndTs: now + 86_400_000,
        task,
      }));

      const persistence = new TaskRunPersistence(store.db);
      persistence.transition(requestId, TaskRunState.CLAIMED);
      persistence.transition(requestId, TaskRunState.WAITING);
      persistence.transition(requestId, TaskRunState.PRE_SNAPSHOT);
      persistence.transition(requestId, TaskRunState.RUNNING);

      await expect(engine.process(requestId)).rejects.toThrow(
        /pins harness version '2\.0\.0'/,
      );

      expect(runCalled).not.toHaveBeenCalled();
      expect(persistence.getByRequestId(requestId)?.state).toBe(TaskRunState.FAILED);
    });

    it('rejects a harness pin that does not match the resolved SolverNet', async () => {
      const engine = await makeEngine();
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_B }),
        executionRequest: { harness: 'codex' },
      };

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/pins harness 'codex'/);
        expect(accept.reason).toMatch(/resolved Harness is 'claude-code'/);
      }
      // Rejected before model invocation — the mismatched harness's canAttempt
      // (and a fortiori its `run`) must never be called.
      expect(claudeCanAttempt).not.toHaveBeenCalled();
      expect(codexCanAttempt).not.toHaveBeenCalled();
    });

    it('rejects a model pin that does not match the resolved SolverNet', async () => {
      const engine = await makeEngine();
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_B }),
        executionRequest: { model: 'gpt-5-codex' },
      };

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/pins model 'gpt-5-codex'/);
        expect(accept.reason).toMatch(/resolved SolverNet model is 'claude-sonnet-5'/);
      }
    });

    it('rejects a harness version pin that does not match the resolved Harness', async () => {
      const engine = await makeEngine();
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_B }),
        executionRequest: { version: '9.9.9' },
      };

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/pins harness version '9.9.9'/);
        expect(accept.reason).toMatch(/is version '2.0.0'/);
      }
    });

    it('accepts an execution request whose pins all match the resolved profile', async () => {
      const engine = await makeEngine();
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_B }),
        executionRequest: { harness: 'claude-code', model: 'claude-sonnet-5', version: '2.0.0' },
      };

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept).toEqual({ ok: true });
      expect(claudeCanAttempt).toHaveBeenCalledTimes(1);
    });

    it('does not invoke an alternative Harness when the manifest-pinned Harness is unavailable and the request omits harness', async () => {
      const solverNetRegistry = new SolverNetRegistry();
      await registerJoinedNet(solverNetRegistry, CID_A, {
        manifestCid: CID_A,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'missing-harness',
        model: 'gpt-5-codex',
        plugins: [],
      });
      const implRegistry = new HarnessRegistry({ default: 'codex' });
      implRegistry.register(stubHarness('codex', '1.0.0', codexCanAttempt));
      const engine = buildEngine({
        implRegistry,
        solverNetRegistry,
        manifestResolver: makeStubManifestResolver({
          [CID_A]: buildPredictionV1ManifestStub(),
        }),
      });
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_A }),
        executionRequest: { model: 'gpt-5-codex' },
      };
      expect(task.executionRequest?.harness).toBeUndefined();

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept.ok).toBe(false);
      expect(codexCanAttempt).not.toHaveBeenCalled();
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

    it('does not validate loadoutRef/isolation — Core carries them opaquely', async () => {
      const engine = await makeEngine();
      const task: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_B }),
        executionRequest: { loadoutRef: 'arm-a', isolation: 'dedicated' },
      };

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept).toEqual({ ok: true });
    });
  });

  describe('AC4 — existing tasks without an execution request are unaffected', () => {
    it('keeps a manifest-bound task dispatchable when no SolverNet registry is wired', async () => {
      const engine = buildEngine({
        manifestResolver: makeStubManifestResolver({
          [CID_A]: buildPredictionV1ManifestStub(),
        }),
      });
      const task = makePredictionV1Task({ solverNetManifestCid: CID_A });
      expect(task.executionRequest).toBeUndefined();

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept).toEqual({ ok: true });
      expect(codexCanAttempt).toHaveBeenCalledTimes(1);
      expect(claudeCanAttempt).not.toHaveBeenCalled();
    });

    it('accepts a task with no executionRequest field exactly as before', async () => {
      const engine = await makeEngine();
      const task = makePredictionV1Task({ solverNetManifestCid: CID_A });
      expect(task.executionRequest).toBeUndefined();

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept).toEqual({ ok: true });
    });

    it('dual-role join still dispatches evaluation via the evaluator harness (not the solver harness pin)', async () => {
      // Reproduction of the review finding on PR #2081: registerJoinedNet stores
      // the solver harness on LoadedSolverNet.harness when roles include
      // 'solver'. Passing that name as harnessName for role=evaluation fails
      // closed because production solver harnesses return
      // supports(evaluation) === false. Stubs that ignore role mask this.
      const solverCanAttempt = vi.fn(async () => ({ ok: true as const }));
      const evalCanAttempt = vi.fn(async () => ({ ok: true as const }));
      const implRegistry = new HarnessRegistry();
      implRegistry.register({
        name: 'claude-code',
        version: '2.0.0',
        supports: ({ solverType, role }) =>
          solverType === 'prediction.v1' && role !== 'evaluation',
        canAttempt: solverCanAttempt,
        run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
      });
      implRegistry.register({
        name: 'prediction-v1-evaluator',
        version: '1.0.0',
        supports: ({ solverType, role }) =>
          solverType === 'prediction.v1' && role === 'evaluation',
        canAttempt: evalCanAttempt,
        run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
      });

      const solverNetRegistry = new SolverNetRegistry();
      await registerJoinedNet(solverNetRegistry, CID_A, {
        manifestCid: CID_A,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'claude-code',
        model: 'claude-sonnet-5',
        plugins: [],
      });
      expect(solverNetRegistry.forManifestCid(CID_A)?.harness).toBe('claude-code');

      const engine = buildEngine({
        implRegistry,
        solverNetRegistry,
        manifestResolver: makeStubManifestResolver({
          [CID_A]: buildPredictionV1ManifestStub(),
        }),
        joinedSolverNets: joinedSolverNetsViewFromConfig({
          [CID_A]: { manifestCid: CID_A, roles: ['solver', 'evaluator'] },
        }),
      });

      const restoration = await engine.canAcceptTask({
        taskRole: 'restoration',
        task: makePredictionV1Task({ solverNetManifestCid: CID_A }),
      });
      expect(restoration).toEqual({ ok: true });
      expect(solverCanAttempt).toHaveBeenCalledTimes(1);
      expect(evalCanAttempt).not.toHaveBeenCalled();

      const evaluation = await engine.canAcceptTask({
        taskRole: 'evaluation',
        task: {
          ...makePredictionV1Task({ solverNetManifestCid: CID_A }),
          role: 'evaluation',
        },
      });
      expect(evaluation).toEqual({ ok: true });
      expect(evalCanAttempt).toHaveBeenCalledTimes(1);
    });

    it('dual-role evaluation ignores inherited restoration executionRequest harness/version pins (issue #2165)', async () => {
      // MechAdapter.buildEvaluationTask historically spread the restoration
      // task, copying executionRequest. After dual-role fallthrough selects
      // the evaluator, role-blind validateExecutionRequest compared the
      // solver pin to the evaluator impl and false-rejected.
      const evalRun = vi.fn(async (): Promise<Solution> => ({
        venueRef: { name: 'stub' },
        gating: {},
      }));
      const solverCanAttempt = vi.fn(async () => ({ ok: true as const }));
      const evalCanAttempt = vi.fn(async () => ({ ok: true as const }));
      const implRegistry = new HarnessRegistry();
      implRegistry.register({
        name: 'claude-code',
        version: '2.0.0',
        supports: ({ solverType, role }) =>
          solverType === 'prediction.v1' && role !== 'evaluation',
        canAttempt: solverCanAttempt,
        run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
      });
      implRegistry.register({
        name: 'prediction-v1-evaluator',
        version: '1.0.0',
        supports: ({ solverType, role }) =>
          solverType === 'prediction.v1' && role === 'evaluation',
        canAttempt: evalCanAttempt,
        run: evalRun,
      });

      const solverNetRegistry = new SolverNetRegistry();
      await registerJoinedNet(solverNetRegistry, CID_A, {
        manifestCid: CID_A,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'claude-code',
        model: 'claude-sonnet-5',
        plugins: [],
      });

      const engine = buildEngine({
        implRegistry,
        solverNetRegistry,
        manifestResolver: makeStubManifestResolver({
          [CID_A]: buildPredictionV1ManifestStub(),
        }),
        joinedSolverNets: joinedSolverNetsViewFromConfig({
          [CID_A]: { manifestCid: CID_A, roles: ['solver', 'evaluator'] },
        }),
      });

      // Simulate what a pre-#2165 buildEvaluationTask produced: evaluation
      // role with the restoration solver profile still attached.
      const evaluationTask: Task = {
        ...makePredictionV1Task({ solverNetManifestCid: CID_A }),
        role: 'evaluation',
        executionRequest: { harness: 'claude-code', version: '2.0.0' },
      };

      const accept = await engine.canAcceptTask({
        taskRole: 'evaluation',
        task: evaluationTask,
      });
      expect(accept).toEqual({ ok: true });
      expect(evalCanAttempt).toHaveBeenCalledTimes(1);
      expect(solverCanAttempt).not.toHaveBeenCalled();

      const requestId = 'eval-inherited-execution-request';
      const now = Date.now();
      await engine.observe(makeIntentInput({
        requestId,
        solverType: 'prediction.v1',
        taskRole: 'evaluation',
        windowStartTs: now - 1000,
        windowEndTs: now + 86_400_000,
        task: evaluationTask,
      }));

      const persistence = new TaskRunPersistence(store.db);
      persistence.transition(requestId, TaskRunState.CLAIMED);
      persistence.transition(requestId, TaskRunState.WAITING);
      persistence.transition(requestId, TaskRunState.PRE_SNAPSHOT);

      // process advances PRE_SNAPSHOT → RUNNING (provision) → runImpl. The
      // inherited solver harness/version pin must not false-reject here.
      await engine.process(requestId);

      expect(evalRun).toHaveBeenCalledTimes(1);
      expect(persistence.getByRequestId(requestId)?.state).not.toBe(TaskRunState.FAILED);
    });
  });
});
