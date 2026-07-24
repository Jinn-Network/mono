import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../../src/store/store.js';
import { TaskEngine, type ManifestResolver } from '../../../src/harnesses/engine/engine.js';
import { buildHarnesses } from '../../../src/harnesses/impls/index.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import { PREDICTION_V1_SOLVER_NET_CONTRACT } from '../../../src/solver-nets/contracts.js';
import { SolverNetRegistry } from '../../../src/solver-nets/registry.js';
import type { Task } from '../../../src/types/task.js';
import {
  makePredictionV1Task,
  TEST_PREDICTION_V1_MANIFEST_CID,
} from '../impls/prediction-v1-test-helpers.js';
import { makeStubManifestResolver } from './manifest-resolver-stub.js';

function stubHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    name: 'prediction-v1-test-harness',
    version: '1.0.0',
    supports: ({ solverType, role }) => solverType === 'prediction.v1' && role !== 'evaluation',
    run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
    ...overrides,
  };
}

function fixtureSolverNetRegistry(
  manifestCid = TEST_PREDICTION_V1_MANIFEST_CID,
  solverType = 'prediction.v1',
): SolverNetRegistry {
  const registry = new SolverNetRegistry();
  registry.register({
    name: manifestCid,
    manifestCid,
    enabled: true,
    solverType,
    roles: ['solving'],
    contract: PREDICTION_V1_SOLVER_NET_CONTRACT,
    harness: 'prediction-v1-test-harness',
    runtimePlugins: [],
    taskGenerator: { enabled: false },
  });
  return registry;
}

describe('prediction.v1 runtime gate', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-prediction-v1-gate-'));
    store = new Store(join(dir, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildHarnesses wires prediction.v1 to the Polymarket v1 baseline and evaluator', () => {
    const harnesses = buildHarnesses({
      stub: true,
      rpcUrl: 'http://127.0.0.1:8545',
      claudePath: 'claude',
      claudeModel: 'test-model',
    });

    const restoration = harnesses.find((harness) => harness.supports({
      solverType: 'prediction.v1',
      role: 'restoration',
    }));
    const evaluation = harnesses.find((harness) => harness.supports({
      solverType: 'prediction.v1',
      role: 'evaluation',
    }));

    expect(restoration?.name).toBe('prediction-v1-baseline');
    expect(evaluation?.name).toBe('prediction-v1-evaluator');
    expect(harnesses.map((harness) => harness.name)).not.toContain('prediction-v0-baseline');
    expect(harnesses.map((harness) => harness.name)).not.toContain('prediction-v0-evaluator');
  });

  it('rejects schema-invalid prediction.v1 Tasks before a harness attempt', async () => {
    const canAttempt = vi.fn(async () => ({ ok: true as const }));
    const engine = new TaskEngine({
      store,
      paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl-state') },
      implRegistry: { findFor: () => stubHarness({ canAttempt }) },
      solverNetRegistry: fixtureSolverNetRegistry(),
      manifestResolver: makeStubManifestResolver(),
    });
    const task = {
      ...makePredictionV1Task(),
      spec: { source: { venue: 'polymarket' } },
    } as unknown as Task;

    const accept = await engine.canAcceptTask({
      solverType: 'prediction.v1',
      taskRole: 'restoration',
      task,
    });

    expect(accept.ok).toBe(false);
    if (!accept.ok) {
      expect(accept.reason).toMatch(/prediction\.v1 task failed validation/);
      expect(accept.reason).toMatch(/spec\.question/);
    }
    expect(canAttempt).not.toHaveBeenCalled();
  });

  it('passes a schema-valid prediction.v1 Task through harness canAttempt', async () => {
    const canAttempt = vi.fn(async () => ({ ok: false as const, reason: 'operator policy declined' }));
    const engine = new TaskEngine({
      store,
      paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl-state') },
      implRegistry: { findFor: () => stubHarness({ canAttempt }) },
      solverNetRegistry: fixtureSolverNetRegistry(),
      manifestResolver: makeStubManifestResolver(),
    });
    const task = makePredictionV1Task();

    const accept = await engine.canAcceptTask({
      solverType: 'prediction.v1',
      taskRole: 'restoration',
      task,
    });

    expect(accept).toEqual({
      ok: false,
      reason: "impl 'prediction-v1-test-harness' cannot attempt task: operator policy declined",
    });
    expect(canAttempt).toHaveBeenCalledWith(task);
  });

  // Task 27 of `spec/2026-05-05-solvernet-creation-and-launch.md` — the
  // §14 task validation pipeline: resolve manifest → contract → schemas.
  describe('Task 27 — manifest-backed task validation', () => {
    function makeEngine(opts: {
      manifestResolver?: ManifestResolver;
      canAttempt?: (task: Task) => Promise<{ ok: true } | { ok: false; reason: string }>;
      manifestCid?: string;
      solverType?: string;
    } = {}): TaskEngine {
      const canAttempt = opts.canAttempt ?? (async () => ({ ok: true as const }));
      return new TaskEngine({
        store,
        paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl-state') },
        implRegistry: { findFor: () => stubHarness({ canAttempt }) },
        solverNetRegistry: fixtureSolverNetRegistry(opts.manifestCid, opts.solverType),
        ...(opts.manifestResolver ? { manifestResolver: opts.manifestResolver } : {}),
      });
    }

    it('resolves the manifest, validates the body, and dispatches via the contract id+version alias', async () => {
      const resolver = makeStubManifestResolver();
      const canAttempt = vi.fn(async () => ({ ok: true as const }));
      const findFor = vi.fn((ctx: { solverType: string; role?: string }) => {
        if (ctx.solverType === 'prediction.v1' && ctx.role === 'restoration') {
          return stubHarness({ canAttempt });
        }
        return undefined;
      });
      const engine = new TaskEngine({
        store,
        paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl-state') },
        implRegistry: { findFor },
        solverNetRegistry: fixtureSolverNetRegistry(),
        manifestResolver: resolver,
      });
      const task = makePredictionV1Task();

      const accept = await engine.canAcceptTask({
        // Routing alias parameter intentionally left unset — the engine
        // should derive `prediction.v1` from `task.contractId/Version`.
        taskRole: 'restoration',
        task,
      });

      expect(accept).toEqual({ ok: true });
      expect(resolver.getManifest).toHaveBeenCalledWith({
        manifestCid: TEST_PREDICTION_V1_MANIFEST_CID,
      });
      // Harness lookup keyed by `${contractId}.${contractVersion}`.
      expect(findFor).toHaveBeenCalledWith({
        solverType: 'prediction.v1',
        role: 'restoration',
        harnessName: 'prediction-v1-test-harness',
      });
      expect(canAttempt).toHaveBeenCalledWith(task);
    });

    it('surfaces an explicit failure when manifest resolution throws', async () => {
      const failingResolver: ManifestResolver = {
        getManifest: vi.fn(async () => {
          throw new Error('manifest not found for cid');
        }),
      };
      const engine = makeEngine({
        manifestResolver: failingResolver,
        manifestCid: 'bafy-does-not-exist',
      });
      const task = makePredictionV1Task({
        solverNetManifestCid: 'bafy-does-not-exist',
      });

      const accept = await engine.canAcceptTask({
        solverType: 'prediction.v1',
        taskRole: 'restoration',
        task,
      });

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/manifest resolution failed/);
        expect(accept.reason).toMatch(/bafy-does-not-exist/);
      }
    });

    it('rejects a task when contractId disagrees with the manifest', async () => {
      const engine = makeEngine({
        manifestResolver: makeStubManifestResolver(),
        solverType: 'forecasting.v1',
      });
      const task = makePredictionV1Task({
        contractId: 'forecasting' as 'prediction',
      });

      const accept = await engine.canAcceptTask({
        taskRole: 'restoration',
        task,
      });

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/contractId 'forecasting' does not match manifest contract\.id 'prediction'/);
      }
    });

    it('rejects a task body that fails the resolved contract schema', async () => {
      const engine = makeEngine({ manifestResolver: makeStubManifestResolver() });
      const task = {
        ...makePredictionV1Task(),
        spec: { source: { venue: 'polymarket' } },
      } as unknown as Task;

      const accept = await engine.canAcceptTask({
        taskRole: 'restoration',
        task,
      });

      expect(accept.ok).toBe(false);
      if (!accept.ok) {
        expect(accept.reason).toMatch(/prediction\.v1 task failed validation/);
      }
    });

    it('skips manifest validation when no resolver is wired and no CID is supplied (legacy / health-check path)', async () => {
      const engine = makeEngine();
      const task: Task = {
        id: 'health-check',
        description: 'health check',
      };

      const accept = await engine.canAcceptTask({
        // No solverType either — this is the legacy health-check shape.
        taskRole: 'restoration',
        task,
      });

      expect(accept).toEqual({ ok: true });
    });
  });
});
