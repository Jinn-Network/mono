import { describe, expect, it, vi } from 'vitest';
import {
  runEval,
  ParentNotEvaluatedError,
  FreezeFenceViolationError,
  CheckpointStateMismatchError,
  SlateHashMismatchError,
  type EvalOrchestratorDeps,
} from '@/eval/orchestrator.js';
import type { ResolvedSlateTask } from '@/eval/resolve-slate-tasks.js';
import type { LoadedHeldOutSlate } from '@/solver-types/_swe-rebench-v2-held-out-slate.js';
import type { HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import type { HfRow } from '@/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { EvalCouldNotGradeError, InsufficientDiskError } from '@/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { Store } from '@/store/store.js';

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

/**
 * A frozen-mode `runHarnessOnce` mock that emits the manifest codeDigest (so the
 * C1 guard passes) and a per-task patch. Shared by every deps factory below; the
 * mismatch / violation cases override it.
 */
function frozenRunOnce(): EvalOrchestratorDeps['runHarnessOnce'] {
  return vi.fn(async ({ task }) => ({
    envelope: { executor: { mode: 'frozen' as const, codeDigest: manifest.codeDigest } },
    solution: { patch: `patch-${task?.id ?? 'x'}` },
  }));
}

/** A mocked evaluator whose "policy" grades exactly `passIds` as passed. */
function passIdEvaluator(passIds: Set<string>): EvalOrchestratorDeps['evaluator'] {
  return {
    grade: vi.fn(async ({ task }: { task: { instance_id: string } }) => ({
      schemaVersion: 'swe-rebench-v2-verdict.v1' as const,
      score: passIds.has(task.instance_id) ? (1 as const) : (0 as const),
      passed_match: passIds.has(task.instance_id),
      evaluator_cost_usd: 0,
      test_log: 'log',
    })),
  } as unknown as EvalOrchestratorDeps['evaluator'];
}

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
    // Both arms were evaluated against the current slate content → no drift.
    getEvalSlateHashes: vi.fn(() => [slate.hash]),
  };
  return {
    harness: {} as EvalOrchestratorDeps['harness'],
    fetchImplStateDirToLocal: vi.fn(async () => '/tmp/impl'),
    evaluator: passIdEvaluator(new Set(['a-1'])),
    runHarnessOnce: frozenRunOnce(),
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
        // Parent has no recorded rows → no hashes → no drift (the end-of-run
        // ParentNotEvaluatedError is what fires for an unevaluated parent).
        getEvalSlateHashes: vi.fn(() => []),
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

// ── Instrument-level discrimination + confounder control ────────────────────────
//
// These drive the FULL `runEval` instrument (run → grade → record → aggregate →
// compare) through a REAL in-memory Store, so the comparison is computed from
// rows the orchestrator actually persisted and aggregated — not hand-fed counts
// (wilson.test.ts already covers the math primitive in isolation). Only the
// harness run and the evaluator are mocked, per the "no Docker / no inference"
// constraint. A "policy" is expressed as the set of instance_ids its evaluator
// grades as passed. Confounder control is the discipline that the SAME slate and
// the SAME parent baseline are used across policies — only the policy varies.

const N10 = Array.from({ length: 10 }, (_, i) => `inst-${String(i).padStart(2, '0')}`);

function slateOf(ids: string[], hash: `sha256:${string}` = 'sha256:fixed-slate'): LoadedHeldOutSlate {
  return { version: 'v1', hash, instanceIds: new Set(ids) };
}

function tasksFor(ids: string[]): ResolvedSlateTask[] {
  return ids.map(stubTask);
}

/**
 * Deps wired to a REAL store whose evaluator grades exactly `passIds` as passed —
 * the "policy" under test. Reuses the same frozen harness + pass-set evaluator
 * factories as baseDeps; only the store (real vs mock) differs.
 */
function policyDeps(store: Store, passIds: Set<string>): EvalOrchestratorDeps {
  return {
    harness: {} as EvalOrchestratorDeps['harness'],
    fetchImplStateDirToLocal: vi.fn(async () => '/tmp/impl'),
    evaluator: passIdEvaluator(passIds),
    runHarnessOnce: frozenRunOnce(),
    store,
  };
}

/** Seed a parent checkpoint as if it had already been evaluated on `slate`. */
function seedParentBaseline(
  store: Store,
  parentCid: string,
  slate: LoadedHeldOutSlate,
  passIds: Set<string>,
): void {
  for (const id of slate.instanceIds) {
    store.recordEvalResult({
      checkpoint_cid: parentCid,
      slate_hash: slate.hash,
      slate_version: slate.version,
      instance_id: id,
      passed: passIds.has(id),
      unscorable: false,
      code_digest: 'sha256:parent-digest',
      run_at_ms: 0,
    });
  }
}

describe('runEval — confounder control: slate-content drift guard', () => {
  it('refuses to compare when the parent was scored on a DIFFERENT slate content under the same version (fail fast, records nothing)', async () => {
    const store = new Store(':memory:');
    try {
      const childSlate = slateOf(N10, 'sha256:content-NEW');
      // Parent was evaluated against the OLD slate content under the SAME 'v1'
      // label — a version-bump-skipped edit. Comparing child-vs-parent now would
      // silently reintroduce confounder #1 (two checkpoints on different task sets).
      seedParentBaseline(store, 'cid-parent', slateOf(N10, 'sha256:content-OLD'), new Set(N10.slice(0, 5)));

      const deps = policyDeps(store, new Set(N10.slice(0, 9)));
      let threw: unknown;
      try {
        await runEval({
          checkpointManifest: manifest,
          checkpointCid: 'cid-child',
          slate: childSlate,
          tasksWithRows: tasksFor(N10),
          parentCheckpointCid: 'cid-parent',
          deps,
        });
      } catch (err) {
        threw = err;
      }

      expect(threw).toBeInstanceOf(SlateHashMismatchError);
      expect((threw as SlateHashMismatchError).message).toMatch(/different slate content|slate.*drift|same version/i);
      expect((threw as SlateHashMismatchError).message).toContain('cid-parent');
      // Fail fast BEFORE burning N× spend: the slate never ran, nothing recorded.
      expect(deps.runHarnessOnce).not.toHaveBeenCalled();
      expect(store.getEvalResults('cid-child', 'v1')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('refuses when the CHILD carries stale rows from a prior different-content eval (guard is symmetric)', async () => {
    const store = new Store(':memory:');
    try {
      const currentSlate = slateOf(N10, 'sha256:content-NEW');
      // Parent is clean — already evaluated against the CURRENT content.
      seedParentBaseline(store, 'cid-parent', currentSlate, new Set(N10.slice(0, 5)));
      // The CHILD carries stale rows for instances NO LONGER in the slate, from a
      // prior eval against the OLD content under the same 'v1' label. recordEvalResult
      // upserts by instance_id and never deletes, so these survive the new run and
      // would silently mix two contents into getEvalAggregate(child). A parent-only
      // guard misses this; the symmetric guard must catch it.
      seedParentBaseline(store, 'cid-child', slateOf(['gone-1', 'gone-2'], 'sha256:content-OLD'), new Set(['gone-1']));

      const deps = policyDeps(store, new Set(N10.slice(0, 9)));
      let threw: unknown;
      try {
        await runEval({
          checkpointManifest: manifest,
          checkpointCid: 'cid-child',
          slate: currentSlate,
          tasksWithRows: tasksFor(N10),
          parentCheckpointCid: 'cid-parent',
          deps,
        });
      } catch (err) {
        threw = err;
      }

      expect(threw).toBeInstanceOf(SlateHashMismatchError);
      // The error names the offending checkpoint — here it is the CHILD.
      expect((threw as SlateHashMismatchError).message).toContain('cid-child');
      // Fail fast: never ran the harness, never compounded the stale rows.
      expect(deps.runHarnessOnce).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it('compares normally when the parent was scored on the SAME slate content', async () => {
    const store = new Store(':memory:');
    try {
      const slate = slateOf(N10, 'sha256:same-content');
      seedParentBaseline(store, 'cid-parent', slate, new Set(N10.slice(0, 5)));

      const deps = policyDeps(store, new Set(N10.slice(0, 6)));
      const result = await runEval({
        checkpointManifest: manifest,
        checkpointCid: 'cid-child',
        slate,
        tasksWithRows: tasksFor(N10),
        parentCheckpointCid: 'cid-parent',
        deps,
      });
      // Same content → no drift → the instrument runs and compares.
      expect(deps.runHarnessOnce).toHaveBeenCalledTimes(10);
      expect(result.comparison.child.p).toBeCloseTo(0.6, 5);
      expect(result.comparison.parent.p).toBeCloseTo(0.5, 5);
    } finally {
      store.close();
    }
  });
});

describe('runEval — discrimination: a better policy scores higher than a worse one', () => {
  it('ranks a better policy above a worse one on the SAME slate and SAME parent baseline', async () => {
    const store = new Store(':memory:');
    try {
      const slate = slateOf(N10);
      // One fixed parent baseline (5/10) — the held-fixed reference.
      seedParentBaseline(store, 'cid-parent', slate, new Set(N10.slice(0, 5)));

      const better = await runEval({
        checkpointManifest: manifest,
        checkpointCid: 'cid-child-better',
        slate,
        tasksWithRows: tasksFor(N10),
        parentCheckpointCid: 'cid-parent',
        deps: policyDeps(store, new Set(N10.slice(0, 9))), // 9/10
      });
      const worse = await runEval({
        checkpointManifest: manifest,
        checkpointCid: 'cid-child-worse',
        slate,
        tasksWithRows: tasksFor(N10),
        parentCheckpointCid: 'cid-parent',
        deps: policyDeps(store, new Set(N10.slice(0, 2))), // 2/10
      });

      // The instrument ranks the better policy above the worse one…
      expect(better.comparison.child.p).toBeGreaterThan(worse.comparison.child.p);
      expect(better.comparison.child.p).toBeCloseTo(0.9, 5);
      expect(worse.comparison.child.p).toBeCloseTo(0.2, 5);
      // …and the delta sign points the right way against the shared baseline.
      expect(better.comparison.delta).toBeGreaterThan(0); // 0.9 − 0.5
      expect(worse.comparison.delta).toBeLessThan(0); // 0.2 − 0.5
      expect(better.comparison.delta).toBeGreaterThan(worse.comparison.delta);
    } finally {
      store.close();
    }
  });

  it('reports a large improvement as trustworthy with a positive delta (CI moves the right way)', async () => {
    const store = new Store(':memory:');
    try {
      const slate = slateOf(N10);
      seedParentBaseline(store, 'cid-parent', slate, new Set(N10.slice(0, 2))); // weak baseline 2/10

      const result = await runEval({
        checkpointManifest: manifest,
        checkpointCid: 'cid-child',
        slate,
        tasksWithRows: tasksFor(N10),
        parentCheckpointCid: 'cid-parent',
        deps: policyDeps(store, new Set(N10.slice(0, 9))), // strong child 9/10
      });

      expect(result.comparison.child.p).toBeCloseTo(0.9, 5);
      expect(result.comparison.parent.p).toBeCloseTo(0.2, 5);
      expect(result.comparison.delta).toBeCloseTo(0.7, 5);
      // 9/10 vs 2/10 → disjoint Wilson intervals → trustworthy.
      expect(result.comparison.verdict).toBe('trustworthy');
    } finally {
      store.close();
    }
  });

  it('reports a regression as trustworthy with a NEGATIVE delta (sign flips the right way)', async () => {
    const store = new Store(':memory:');
    try {
      const slate = slateOf(N10);
      seedParentBaseline(store, 'cid-parent', slate, new Set(N10.slice(0, 9))); // strong baseline 9/10

      const result = await runEval({
        checkpointManifest: manifest,
        checkpointCid: 'cid-child',
        slate,
        tasksWithRows: tasksFor(N10),
        parentCheckpointCid: 'cid-parent',
        deps: policyDeps(store, new Set(N10.slice(0, 2))), // regressed child 2/10
      });

      expect(result.comparison.child.p).toBeCloseTo(0.2, 5);
      expect(result.comparison.parent.p).toBeCloseTo(0.9, 5);
      expect(result.comparison.delta).toBeCloseTo(-0.7, 5);
      expect(result.comparison.verdict).toBe('trustworthy');
    } finally {
      store.close();
    }
  });

  it('withholds the trustworthy claim for a small improvement (only large deltas are trustworthy — never weaken the exam)', async () => {
    const store = new Store(':memory:');
    try {
      const slate = slateOf(N10);
      seedParentBaseline(store, 'cid-parent', slate, new Set(N10.slice(0, 5))); // 5/10

      const result = await runEval({
        checkpointManifest: manifest,
        checkpointCid: 'cid-child',
        slate,
        tasksWithRows: tasksFor(N10),
        parentCheckpointCid: 'cid-parent',
        deps: policyDeps(store, new Set(N10.slice(0, 6))), // +1 instance: 6/10
      });

      // A real but tiny gain: the delta is positive…
      expect(result.comparison.delta).toBeGreaterThan(0);
      expect(result.comparison.delta).toBeCloseTo(0.1, 5);
      // …but at N=10 the Wilson intervals overlap, so the exam refuses to over-claim.
      expect(result.comparison.verdict).toBe('within-noise');
    } finally {
      store.close();
    }
  });
});
