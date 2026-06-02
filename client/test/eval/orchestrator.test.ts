import { describe, expect, it, vi } from 'vitest';
import {
  runEval,
  ParentNotEvaluatedError,
  FreezeFenceViolationError,
  CheckpointStateMismatchError,
  type EvalOrchestratorDeps,
} from '@/eval/orchestrator.js';
import type { ResolvedSlateTask } from '@/eval/resolve-slate-tasks.js';
import type { LoadedHeldOutSlate } from '@/solver-types/_swe-rebench-v2-held-out-slate.js';
import type { HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import type { HfRow } from '@/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { EvalCouldNotGradeError, InsufficientDiskError } from '@/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

function stubRow(instance_id: string): HfRow {
  return {
    instance_id,
    repo: 'org/repo',
    image_name: `img-${instance_id}`,
    FAIL_TO_PASS: ['t1'],
    PASS_TO_PASS: ['t2'],
    test_patch: 'diff',
    install_config: { test_cmd: 'pytest', log_parser: 'pytest' },
  };
}

function stubTask(instance_id: string): ResolvedSlateTask {
  return {
    task: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id,
      repo: 'org/repo',
      base_commit: '0'.repeat(40),
      language: 'python',
      problem_statement: '',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench',
      hf_split: '2026_02',
      deadline_unix: 1,
      round_month: '2026-02',
    },
    row: stubRow(instance_id),
  };
}

const slate: LoadedHeldOutSlate = {
  version: 'v1',
  hash: 'sha256:slate',
  instanceIds: new Set(['a-1', 'b-2']),
};

const manifest = {
  parentCheckpointCid: 'cid-parent',
  implStateDirCid: 'impl-cid',
  codeDigest: 'sha256:' + 'd'.repeat(64),
} as unknown as HarnessCheckpointManifest;

function baseDeps(over: Partial<EvalOrchestratorDeps> = {}): EvalOrchestratorDeps {
  const recorded: Record<string, { passed: boolean | null; unscorable: boolean }> = {};
  const store: EvalOrchestratorDeps['store'] = {
    recordEvalResult: vi.fn((r) => {
      recorded[r.instance_id] = { passed: r.passed, unscorable: r.unscorable };
    }),
    // child aggregate derives from recorded; parent fixed to a populated value
    getEvalAggregate: vi.fn((cid: string) => {
      if (cid === 'cid-parent') return { passed: 1, scorable: 2, unscorable: 0 };
      const rows = Object.values(recorded);
      const scorable = rows.filter((r) => !r.unscorable);
      return {
        passed: scorable.filter((r) => r.passed === true).length,
        scorable: scorable.length,
        unscorable: rows.filter((r) => r.unscorable).length,
      };
    }),
  };
  return {
    harness: {} as EvalOrchestratorDeps['harness'],
    fetchImplStateDirToLocal: vi.fn(async () => '/tmp/impl'),
    evaluator: {
      grade: vi.fn(async ({ task }) => ({
        schemaVersion: 'swe-rebench-v2-verdict.v1' as const,
        score: task.instance_id === 'a-1' ? (1 as const) : (0 as const),
        passed_match: task.instance_id === 'a-1',
        evaluator_cost_usd: 0,
        test_log: 'log',
      })),
    } as unknown as EvalOrchestratorDeps['evaluator'],
    runHarnessOnce: vi.fn(async ({ task }) => ({
      // Match the manifest codeDigest by default so the C1 guard passes; the
      // mismatch case overrides this.
      envelope: { executor: { mode: 'frozen' as const, codeDigest: manifest.codeDigest } },
      solution: { patch: `patch-${task?.id ?? 'x'}` },
    })),
    store,
    ...over,
  };
}

describe('runEval orchestrator', () => {
  it('AC#1: runs the slate frozen, records per-task pass/fail, returns aggregate', async () => {
    const deps = baseDeps();
    const result = await runEval({
      checkpointManifest: manifest,
      slate,
      tasksWithRows: [stubTask('a-1'), stubTask('b-2')],
      parentCheckpointCid: 'cid-parent',
      checkpointCid: 'cid-child',
      deps,
    });

    expect(deps.store.recordEvalResult).toHaveBeenCalledTimes(2);
    expect(result.perTask).toEqual([
      { instance_id: 'a-1', passed: true, unscorable: false },
      { instance_id: 'b-2', passed: false, unscorable: false },
    ]);
    // provenance: the graded artifact is the local impl-state run (returned by
    // fetchImplStateDirToLocal), with the evaluated digest verified == manifest.
    expect(result.evaluated).toEqual({
      implStateDir: '/tmp/impl',
      codeDigest: manifest.codeDigest,
      matchedCheckpoint: true,
    });
    // every harness run was frozen mode
    for (const call of (deps.runHarnessOnce as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].mode).toBe('frozen');
    }
  });

  it('AC#2: emits a child-vs-parent comparison with Wilson CIs + delta', async () => {
    const deps = baseDeps();
    const result = await runEval({
      checkpointManifest: manifest,
      slate,
      tasksWithRows: [stubTask('a-1'), stubTask('b-2')],
      parentCheckpointCid: 'cid-parent',
      checkpointCid: 'cid-child',
      deps,
    });
    // child 1/2 vs parent 1/2 → delta 0, within-noise
    expect(result.comparison.child.p).toBeCloseTo(0.5, 5);
    expect(result.comparison.parent.p).toBeCloseTo(0.5, 5);
    expect(result.comparison.delta).toBeCloseTo(0, 5);
    expect(result.comparison.verdict).toBe('within-noise');
  });

  it('AC#2: throws ParentNotEvaluatedError when the parent has no rows for the slate version', async () => {
    const deps = baseDeps({
      store: {
        recordEvalResult: vi.fn(),
        getEvalAggregate: vi.fn((cid: string) =>
          cid === 'cid-parent'
            ? { passed: 0, scorable: 0, unscorable: 0 }
            : { passed: 1, scorable: 2, unscorable: 0 },
        ),
      },
    });
    await expect(
      runEval({
        checkpointManifest: manifest,
        slate,
        tasksWithRows: [stubTask('a-1'), stubTask('b-2')],
        parentCheckpointCid: 'cid-parent',
        checkpointCid: 'cid-child',
        deps,
      }),
    ).rejects.toBeInstanceOf(ParentNotEvaluatedError);
  });

  it('AC#3: throws FreezeFenceViolationError on a violation and does not record that instance', async () => {
    const deps = baseDeps({
      runHarnessOnce: vi.fn(async () => ({
        violation: {
          taskId: 'a-1',
          harnessName: 'h',
          harnessVersion: '1',
          stateHashBefore: 'x',
          stateHashAfter: 'y',
          detectedAt: 0,
        },
      })),
    });
    await expect(
      runEval({
        checkpointManifest: manifest,
        slate,
        tasksWithRows: [stubTask('a-1')],
        parentCheckpointCid: 'cid-parent',
        checkpointCid: 'cid-child',
        deps,
      }),
    ).rejects.toBeInstanceOf(FreezeFenceViolationError);
    expect(deps.store.recordEvalResult).not.toHaveBeenCalled();
  });

  it('C1: throws CheckpointStateMismatchError when the evaluated digest != manifest, records nothing', async () => {
    const deps = baseDeps({
      runHarnessOnce: vi.fn(async ({ task }) => ({
        envelope: { executor: { mode: 'frozen' as const, codeDigest: 'sha256:' + 'e'.repeat(64) } },
        solution: { patch: `patch-${task?.id ?? 'x'}` },
      })),
    });
    await expect(
      runEval({
        checkpointManifest: manifest,
        slate,
        tasksWithRows: [stubTask('a-1'), stubTask('b-2')],
        parentCheckpointCid: 'cid-parent',
        checkpointCid: 'cid-child',
        deps,
      }),
    ).rejects.toBeInstanceOf(CheckpointStateMismatchError);
    expect(deps.store.recordEvalResult).not.toHaveBeenCalled();
    // fail fast: never graded an instance (no Docker spend)
    expect(deps.evaluator.grade).not.toHaveBeenCalled();
  });

  it('unscorable: a grade error records unscorable, excluded from denominator', async () => {
    const deps = baseDeps({
      evaluator: {
        grade: vi.fn(async ({ task }) => {
          if (task.instance_id === 'b-2') throw new EvalCouldNotGradeError('docker down');
          return {
            schemaVersion: 'swe-rebench-v2-verdict.v1' as const,
            score: 1 as const,
            passed_match: true,
            evaluator_cost_usd: 0,
            test_log: 'ok',
          };
        }),
      } as unknown as EvalOrchestratorDeps['evaluator'],
    });
    const result = await runEval({
      checkpointManifest: manifest,
      slate,
      tasksWithRows: [stubTask('a-1'), stubTask('b-2')],
      parentCheckpointCid: 'cid-parent',
      checkpointCid: 'cid-child',
      deps,
    });
    expect(result.perTask).toEqual([
      { instance_id: 'a-1', passed: true, unscorable: false },
      { instance_id: 'b-2', passed: null, unscorable: true },
    ]);
    // child scorable = 1, passed = 1
    expect(result.comparison.child.p).toBeCloseTo(1, 5);
  });

  it('unscorable: InsufficientDiskError is also treated as unscorable', async () => {
    const deps = baseDeps({
      evaluator: {
        grade: vi.fn(async () => {
          throw new InsufficientDiskError(1, 20);
        }),
      } as unknown as EvalOrchestratorDeps['evaluator'],
    });
    const result = await runEval({
      checkpointManifest: manifest,
      slate,
      tasksWithRows: [stubTask('a-1')],
      parentCheckpointCid: 'cid-parent',
      checkpointCid: 'cid-child',
      deps,
    });
    expect(result.perTask[0]).toEqual({ instance_id: 'a-1', passed: null, unscorable: true });
  });

  it('unscorable: a generic harness-run error records the instance unscorable and continues the slate', async () => {
    // Defect A: a harness failure (harvest missing-artifact, "no patch", clone/
    // timeout) on ONE instance must NOT abort the whole eval — it is recorded
    // unscorable (passed: null) with the error captured, and remaining instances
    // still run (#476: harness/infra failure is environment-side, not a fail).
    const deps = baseDeps({
      runHarnessOnce: vi.fn(async ({ task }) => {
        if (task?.id === 'a-1') {
          throw new Error('Required artifact missing: /tmp/.orient/summary.json');
        }
        return {
          envelope: { executor: { mode: 'frozen' as const, codeDigest: manifest.codeDigest } },
          solution: { patch: `patch-${task?.id ?? 'x'}` },
        };
      }),
    });
    const recordSpy = deps.store.recordEvalResult as ReturnType<typeof vi.fn>;
    const result = await runEval({
      checkpointManifest: manifest,
      slate,
      tasksWithRows: [stubTask('a-1'), stubTask('b-2')],
      parentCheckpointCid: 'cid-parent',
      checkpointCid: 'cid-child',
      deps,
    });
    expect(result.perTask).toEqual([
      { instance_id: 'a-1', passed: null, unscorable: true },
      { instance_id: 'b-2', passed: false, unscorable: false },
    ]);
    // both instances recorded — the slate ran to completion
    expect(recordSpy).toHaveBeenCalledTimes(2);
    // the harness-failure message is captured in the unscorable record's excerpt
    const aRecord = recordSpy.mock.calls.find((c) => c[0].instance_id === 'a-1')?.[0];
    expect(aRecord?.test_log_excerpt).toContain('Required artifact missing');
    // b-2 was still graded (failing instance did not abort the loop)
    expect(deps.evaluator.grade).toHaveBeenCalledTimes(1);
  });

  it('AC#3: a FreezeFenceViolationError still aborts loudly even with Fix A in place', async () => {
    // Defect A's catch must NOT swallow a real freeze-fence violation — a frozen
    // implStateDir mutation taints the run and must remain terminal.
    const deps = baseDeps({
      runHarnessOnce: vi.fn(async ({ task }) => {
        if (task?.id === 'a-1') {
          return {
            violation: {
              taskId: 'a-1',
              harnessName: 'h',
              harnessVersion: '1',
              stateHashBefore: 'x',
              stateHashAfter: 'y',
              detectedAt: 0,
            },
          };
        }
        return {
          envelope: { executor: { mode: 'frozen' as const, codeDigest: manifest.codeDigest } },
          solution: { patch: 'p' },
        };
      }),
    });
    await expect(
      runEval({
        checkpointManifest: manifest,
        slate,
        tasksWithRows: [stubTask('a-1'), stubTask('b-2')],
        parentCheckpointCid: 'cid-parent',
        checkpointCid: 'cid-child',
        deps,
      }),
    ).rejects.toBeInstanceOf(FreezeFenceViolationError);
  });

  it('fetches the impl-state-dir once for the whole slate (hoisted)', async () => {
    const deps = baseDeps();
    await runEval({
      checkpointManifest: manifest,
      slate,
      tasksWithRows: [stubTask('a-1'), stubTask('b-2')],
      parentCheckpointCid: 'cid-parent',
      checkpointCid: 'cid-child',
      deps,
    });
    expect(deps.fetchImplStateDirToLocal).toHaveBeenCalledTimes(1);
  });
});
