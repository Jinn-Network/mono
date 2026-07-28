import { describe, it, expect, vi } from 'vitest';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/harness.js';
import type { HarnessAdapter, TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';
import * as harvestModule from '../../../../src/harnesses/impls/learner/harvest.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

class CapturingAdapter implements HarnessAdapter {
  readonly name = 'capturing';
  readonly allowsHarnessSelfModification = false;
  public lastInputs?: TaskSessionInputs;
  async runTask(inputs: TaskSessionInputs): Promise<void> {
    this.lastInputs = inputs;
  }
}

function makeMinimalCtx(mode: 'train' | 'frozen'): HarnessContext {
  return {
    task: {
      id: 't1',
      solverType: 'prediction.v1',
      window: { startTs: 0, endTs: 0 },
    } as HarnessContext['task'],
    implStateDir: '/tmp/state',
    workingDir: '/tmp/work',
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: { addSpan: () => {} } as unknown as HarnessContext['trajectory'],
    mode,
  };
}

describe('claude-code-learner mode gate', () => {
  it('forwards mode = "train" through TaskSessionInputs', async () => {
    const harvestSpy = vi.spyOn(harvestModule, 'harvestOutput').mockResolvedValue({
      venueRef: { name: 'claude-code-learner' },
      gating: {},
    } as Awaited<ReturnType<typeof harvestModule.harvestOutput>>);
    try {
      const adapter = new CapturingAdapter();
      const harness = new LearnerHarness({ adapter, pluginRoot: '/tmp/x' });
      await harness.run(makeMinimalCtx('train'));
      expect(adapter.lastInputs?.mode).toBe('train');
    } finally {
      harvestSpy.mockRestore();
    }
  });

  it('forwards mode = "frozen" through TaskSessionInputs', async () => {
    const harvestSpy = vi.spyOn(harvestModule, 'harvestOutput').mockResolvedValue({
      venueRef: { name: 'claude-code-learner' },
      gating: {},
    } as Awaited<ReturnType<typeof harvestModule.harvestOutput>>);
    try {
      const adapter = new CapturingAdapter();
      const harness = new LearnerHarness({ adapter, pluginRoot: '/tmp/x' });
      await harness.run(makeMinimalCtx('frozen'));
      expect(adapter.lastInputs?.mode).toBe('frozen');
    } finally {
      harvestSpy.mockRestore();
    }
  });

  it('passes phaseRange = "solve-only" to harvestOutput in frozen mode', async () => {
    // Defect B: frozen runs skip the learning phases, so harvest must not require
    // their artifacts — solve-only requires none.
    const harvestSpy = vi.spyOn(harvestModule, 'harvestOutput').mockResolvedValue({
      venueRef: { name: 'claude-code-learner' },
      gating: {},
    } as Awaited<ReturnType<typeof harvestModule.harvestOutput>>);
    try {
      const adapter = new CapturingAdapter();
      const harness = new LearnerHarness({ adapter, pluginRoot: '/tmp/x' });
      await harness.run(makeMinimalCtx('frozen'));
      expect(adapter.lastInputs?.adapterEnv).toEqual({
        LEARNER_PHASE_RANGE: 'solve-only',
      });
      expect(harvestSpy).toHaveBeenCalledWith(
        '/tmp/work',
        'solve-only',
        expect.anything(),
        { taskId: undefined, attemptIndex: undefined, requestId: undefined },
      );
    } finally {
      harvestSpy.mockRestore();
    }
  });

  it('passes phaseRange = undefined (→ full) to harvestOutput in train mode', async () => {
    const harvestSpy = vi.spyOn(harvestModule, 'harvestOutput').mockResolvedValue({
      venueRef: { name: 'claude-code-learner' },
      gating: {},
    } as Awaited<ReturnType<typeof harvestModule.harvestOutput>>);
    try {
      const adapter = new CapturingAdapter();
      const harness = new LearnerHarness({ adapter, pluginRoot: '/tmp/x' });
      await harness.run(makeMinimalCtx('train'));
      expect(adapter.lastInputs?.adapterEnv).toBeUndefined();
      expect(harvestSpy).toHaveBeenCalledWith(
        '/tmp/work',
        undefined,
        expect.anything(),
        { taskId: undefined, attemptIndex: undefined, requestId: undefined },
      );
    } finally {
      harvestSpy.mockRestore();
    }
  });

  it.each(['pre-execute', 'post-execute'] as const)(
    'passes configured train phase range %s to both adapter and harvest',
    async (phaseRange) => {
      const priorPhaseRange = process.env.LEARNER_PHASE_RANGE;
      process.env.LEARNER_PHASE_RANGE = phaseRange;
      const harvestSpy = vi.spyOn(harvestModule, 'harvestOutput').mockResolvedValue({
        venueRef: { name: 'claude-code-learner' },
        gating: {},
      } as Awaited<ReturnType<typeof harvestModule.harvestOutput>>);
      try {
        const adapter = new CapturingAdapter();
        const harness = new LearnerHarness({ adapter, pluginRoot: '/tmp/x' });
        await harness.run(makeMinimalCtx('train'));

        expect(adapter.lastInputs?.adapterEnv).toEqual({
          LEARNER_PHASE_RANGE: phaseRange,
        });
        expect(harvestSpy).toHaveBeenCalledWith(
          '/tmp/work',
          phaseRange,
          expect.anything(),
          { taskId: undefined, attemptIndex: undefined, requestId: undefined },
        );
      } finally {
        if (priorPhaseRange === undefined) delete process.env.LEARNER_PHASE_RANGE;
        else process.env.LEARNER_PHASE_RANGE = priorPhaseRange;
        harvestSpy.mockRestore();
      }
    },
  );
});
