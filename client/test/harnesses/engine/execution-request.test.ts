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
import { SolverNetRegistry, registerJoinedNet } from '../../../src/solver-nets/registry.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import type { Task } from '../../../src/types/task.js';
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
    solverNetRegistry?: SolverNetRegistryLike;
    manifestResolver: ManifestResolver;
    joinedSolverNets?: JoinedSolverNetsView;
  }): TaskEngine {
    return new TaskEngine({
      store,
      paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl-state') },
      implRegistry: makeImplRegistry(),
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

    it('rejects a manifest-bound task when no SolverNet registry is wired', async () => {
      const engine = buildEngine({
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
    it('accepts a task with no executionRequest field exactly as before', async () => {
      const engine = await makeEngine();
      const task = makePredictionV1Task({ solverNetManifestCid: CID_A });
      expect(task.executionRequest).toBeUndefined();

      const accept = await engine.canAcceptTask({ taskRole: 'restoration', task });

      expect(accept).toEqual({ ok: true });
    });
  });
});
