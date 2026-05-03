import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../../src/store/store.js';
import { TaskEngine } from '../../../src/harnesses/engine/engine.js';
import { buildHarnesses } from '../../../src/harnesses/impls/index.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import type { Task } from '../../../src/types/task.js';
import { makePredictionV1Task } from '../impls/prediction-v1-test-helpers.js';

function stubHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    name: 'prediction-v1-test-harness',
    version: '1.0.0',
    supports: ({ solverType, role }) => solverType === 'prediction.v1' && role !== 'evaluation',
    run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
    ...overrides,
  };
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
});
