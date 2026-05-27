// client/test/harnesses/impls/hermes-agent/harness.test.ts
import { describe, expect, it, vi } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { HERMES_AGENT_HARNESS } from '../../../../src/harnesses/names.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

vi.mock('../../../../src/harnesses/impls/learner/harvest.js', () => ({
  harvestOutput: vi.fn(async () => ({
    schemaVersion: 'swe-rebench-v2-solution.v1',
    patch: '--- a/x\n+++ b/x\n',
    venueRef: { name: 'placeholder-from-harvest', version: '0' },
  })),
}));

describe('HermesHarness', () => {
  it('reports name = hermes-agent', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.name).toBe(HERMES_AGENT_HARNESS);
    expect(h.name).toBe('hermes-agent');
  });

  it('supports() rejects evaluation role', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
  });

  it('supports() accepts SWE-rebench v2 restoration role', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
  });

  it('supports() rejects non-SWE-rebench v2 restoration solver types', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'prediction.v1', role: 'restoration' })).toBe(false);
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
    expect(h.supports({ solverType: 'portfolio.v0', role: 'restoration' })).toBe(false);
  });

  it('run() delegates to adapter.runTask and overrides venueRef.name to hermes-agent', async () => {
    const runTask = vi.fn().mockResolvedValue(undefined);
    const fakeAdapter = { name: 'hermes-agent', runTask };
    const h = new HermesHarness({ adapter: fakeAdapter as any });

    const ctx: HarnessContext = {
      task: {
        id: 'task-x',
        description: 'test',
        solverType: 'swe-rebench-v2.v1',
        role: 'restoration',
        window: { startTs: 0, endTs: Date.now() + 60_000 },
        spec: { repo: 'a/b', base_commit: 'c'.repeat(40) },
      } as any,
      requestId: 'req-x',
      taskCid: 'bafy…',
      solverNet: { model: 'anthropic/claude-opus-4.6' } as any,
      implStateDir: '/state',
      workingDir: '/work',
      solverPluginRoots: ['/plugin-a'],
      mode: 'train',
      abort: new AbortController().signal,
      msUntilEndTs: () => 60_000,
    } as unknown as HarnessContext;

    const solution = await h.run(ctx);

    expect(runTask).toHaveBeenCalledTimes(1);
    const callArgs = runTask.mock.calls[0][0];
    expect(callArgs.workingDir).toBe('/work');
    expect(callArgs.implStateDir).toBe('/state');
    expect(callArgs.model).toBe('anthropic/claude-opus-4.6');
    expect(callArgs.pluginRoots).toEqual(['/plugin-a']);
    expect(callArgs.mode).toBe('train');

    expect(solution.venueRef.name).toBe(HERMES_AGENT_HARNESS);
    expect(solution.venueRef.name).toBe('hermes-agent');
  });
});
