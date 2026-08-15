// operator/test/harnesses/impls/hermes-agent/harness.test.ts
import { describe, expect, it, vi } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { HERMES_AGENT_HARNESS } from '../../../../src/harnesses/names.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';
import {
  EVAL_SEMANTICS_VERSION,
  SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION,
  SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
} from '../../../../src/solver-types/_swe-rebench-v2-validated-pool.js';

function taskWithVettedRefVersion(evalSemanticsVersion: string): Task {
  return {
    id: 'task-ghost',
    description: 'test',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    eligibility: {
      vettedPoolRef: {
        schemaVersion: SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION,
        artifactType: SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
        manifestCid: 'bafyManifest',
        artifactCid: 'bafyArtifact',
        artifactHash: `sha256:${'a'.repeat(64)}`,
        evalSemanticsVersion,
        publishedAt: '2026-05-29T00:00:00.000Z',
      },
    },
  } as unknown as Task;
}

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

  it('canAttempt() rejects a ghost task whose vettedPoolRef announces a stale semantics version (gh #300)', async () => {
    const h = new HermesHarness({ adapter: { name: 'hermes-agent', runTask: vi.fn() } as any });
    const res = await h.canAttempt(taskWithVettedRefVersion('3'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('evalSemanticsVersion=3');
  });

  it('canAttempt() accepts a task whose vettedPoolRef matches the local semantics version', async () => {
    const h = new HermesHarness({ adapter: { name: 'hermes-agent', runTask: vi.fn() } as any });
    expect((await h.canAttempt(taskWithVettedRefVersion(EVAL_SEMANTICS_VERSION))).ok).toBe(true);
  });

  it('canAttempt() fails open for a task with no vettedPoolRef (recency floor guards these)', async () => {
    const h = new HermesHarness({ adapter: { name: 'hermes-agent', runTask: vi.fn() } as any });
    const task = { id: 't', description: 'd', solverType: 'swe-rebench-v2.v1', role: 'restoration' } as unknown as Task;
    expect((await h.canAttempt(task)).ok).toBe(true);
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
