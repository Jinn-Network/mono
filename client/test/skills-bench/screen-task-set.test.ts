import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideScreening, buildScreeningReceipt, summarizeScreeningDecisions, applyScreeningResults,
  selectTasksForMeasurement, hashTaskSet, loadTaskSet,
  type SkillTaskSetV1, type SkillTaskV1, type TaskRequirement, type ScreeningReceipt,
} from '../../src/skills-bench/task-set.js';
import {
  parseArgs, computeScreeningResults, writeScreenedTaskSet,
} from '../../scripts/skills-bench/screen-task-set.js';

function requirement(over: Partial<TaskRequirement> = {}): TaskRequirement {
  return {
    background: 'The widget module has a bug in its size calculation.',
    requirement: 'Fix the widget so it reports the correct size for empty inputs.',
    fileOps: 'Edit src/widget.py only.',
    acceptance: 'The verifier tests in test_widget_size.py must pass.',
    ...over,
  };
}

function task(over: Partial<SkillTaskV1> = {}): SkillTaskV1 {
  return {
    id: 'fix-widget-0001',
    repo: 'org/widget-repo',
    commit: 'a'.repeat(40),
    image: 'jinn/widget-task:0001',
    requirement: requirement(),
    verifierFiles: ['verifiers/test_widget_size.py'],
    referencePatchFile: 'patches/fix-widget-0001.patch',
    gradeability: { status: 'pass', checkedAt: 'x', referenceMs: 1, emptyMs: 1, gradeLogDigest: 'd' },
    ...over,
  };
}

/** Mirrors task-set.test.ts's makeFixtureSet — a minimal on-disk task-set
 *  fixture whose declared sha256 matches a fresh hash of its referenced files. */
async function makeFixtureSet(opts: { tasks?: SkillTaskV1[] } = {}): Promise<{ dir: string; set: SkillTaskSetV1 }> {
  const dir = await mkdtemp(join(tmpdir(), 'screen-task-set-'));
  const tasks = opts.tasks ?? [task()];
  for (const t of tasks) {
    for (const vf of t.verifierFiles) {
      await mkdir(join(dir, vf, '..'), { recursive: true });
      await writeFile(join(dir, vf), 'def test_size():\n    assert True\n');
    }
    await mkdir(join(dir, t.referencePatchFile, '..'), { recursive: true });
    await writeFile(join(dir, t.referencePatchFile), 'diff --git a/x b/x\n');
  }
  const body = { version: 'skill-task-set.v1' as const, skill: 'tdd', domain: 'python', tasks };
  const sha256 = await hashTaskSet(dir, body);
  const set: SkillTaskSetV1 = { ...body, sha256 };
  await writeFile(join(dir, 'set.json'), `${JSON.stringify(set, null, 2)}\n`);
  return { dir, set };
}

const receipt = (over: Partial<ScreeningReceipt> = {}): ScreeningReceipt => ({
  baselinePasses: 0, attempts: 2, keep: true, screenedAt: '2026-07-31T00:00:00.000Z', model: 'claude-haiku-4-5-20251001',
  ...over,
});

// ---------------------------------------------------------------------------
// Selection rule (pure)
// ---------------------------------------------------------------------------

describe('decideScreening — selection rule (spec §2.4)', () => {
  it('DROPs a task the baseline passed on every repeat (no headroom)', () => {
    expect(decideScreening([true, true])).toEqual({ keep: false, baselinePasses: 2, attempts: 2, ungradeable: false });
  });

  it('KEEPs a task the baseline failed at least once (headroom exists)', () => {
    expect(decideScreening([true, false])).toEqual({ keep: true, baselinePasses: 1, attempts: 2, ungradeable: false });
    expect(decideScreening([false, false])).toEqual({ keep: true, baselinePasses: 0, attempts: 2, ungradeable: false });
  });

  it('DROPs and flags ungradeable when any baseline attempt is unscorable, regardless of the others', () => {
    expect(decideScreening([null, false])).toEqual({ keep: false, baselinePasses: 0, attempts: 2, ungradeable: true });
    // even a baseline that otherwise looks like "no headroom" (all-pass) is
    // reported as ungradeable, not silently folded into "no headroom".
    expect(decideScreening([true, null])).toEqual({ keep: false, baselinePasses: 1, attempts: 2, ungradeable: true });
  });

  it('single-repeat sets still resolve correctly', () => {
    expect(decideScreening([false]).keep).toBe(true);
    expect(decideScreening([true]).keep).toBe(false);
  });

  it('honors a tightened --pass-threshold', () => {
    // 1 failure out of 2 repeats = 50% pass rate: kept at the default
    // threshold (1) but dropped once the threshold is tightened to 0.5.
    expect(decideScreening([true, false], 1).keep).toBe(true);
    expect(decideScreening([true, false], 0.5).keep).toBe(false);
  });

  it('throws on an empty outcomes array', () => {
    expect(() => decideScreening([])).toThrow(/at least one baseline outcome/);
  });

  it.each([0, -0.1, 1.5])('throws on an out-of-range passThreshold (%s)', (bad) => {
    expect(() => decideScreening([true], bad)).toThrow(/passThreshold must be in \(0, 1\]/);
  });
});

describe('buildScreeningReceipt', () => {
  it('renders exactly the spec receipt shape', () => {
    const r = buildScreeningReceipt([true, false], { model: 'claude-haiku-4-5-20251001', screenedAt: '2026-07-31T00:00:00.000Z' });
    expect(r).toEqual({
      baselinePasses: 1, attempts: 2, keep: true,
      screenedAt: '2026-07-31T00:00:00.000Z', model: 'claude-haiku-4-5-20251001',
    });
  });
});

describe('summarizeScreeningDecisions', () => {
  it('partitions kept / dropped-no-headroom / dropped-ungradeable, ungradeable excluded from keep even when listed separately', () => {
    const summary = summarizeScreeningDecisions(
      [
        { taskId: 'has-headroom', decision: { keep: true, baselinePasses: 1, attempts: 2, ungradeable: false } },
        { taskId: 'no-headroom', decision: { keep: false, baselinePasses: 2, attempts: 2, ungradeable: false } },
        { taskId: 'bad-verifier', decision: { keep: false, baselinePasses: 1, attempts: 2, ungradeable: true } },
      ],
      { model: 'claude-haiku-4-5-20251001', repeats: 2, screenedAt: '2026-07-31T00:00:00.000Z' },
    );
    expect(summary.kept).toEqual(['has-headroom']);
    expect(summary.droppedNoHeadroom).toEqual(['no-headroom']);
    expect(summary.droppedUngradeable).toEqual(['bad-verifier']);
    expect(summary.passThreshold).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeScreeningResults (screen-task-set.ts orchestration, no subprocess)
// ---------------------------------------------------------------------------

describe('computeScreeningResults', () => {
  it('builds one receipt + decision per task id from grouped baseline outcomes', () => {
    const results = computeScreeningResults(
      ['t1', 't2'],
      new Map([['t1', [true, false]], ['t2', [true, true]]]),
      { model: 'claude-haiku-4-5-20251001', passThreshold: 1, screenedAt: '2026-07-31T00:00:00.000Z' },
    );
    expect(results.find((r) => r.taskId === 't1')!.decision.keep).toBe(true);
    expect(results.find((r) => r.taskId === 't2')!.decision.keep).toBe(false);
  });

  it('throws loud when a task has no recorded baseline attempts', () => {
    expect(() => computeScreeningResults(
      ['t1', 't2'],
      new Map([['t1', [true]]]),
      { model: 'claude-haiku-4-5-20251001', passThreshold: 1 },
    )).toThrow(/no baseline attempts recorded for task 't2'/);
  });
});

// ---------------------------------------------------------------------------
// Receipt write + reload round-trip
// ---------------------------------------------------------------------------

describe('screening receipt write + reload round-trip', () => {
  it('writes screening + screeningSummary into set.json without changing sha256, and reloads them intact', async () => {
    const t1 = task({ id: 't1' });
    const t2 = task({ id: 't2', verifierFiles: ['verifiers/test_widget_size.py'], referencePatchFile: 'patches/fix-widget-0001.patch' });
    const { dir, set } = await makeFixtureSet({ tasks: [t1, t2] });

    const receipts = new Map([
      ['t1', receipt({ keep: true, baselinePasses: 1 })],
      ['t2', receipt({ keep: false, baselinePasses: 2 })],
    ]);
    const summary = summarizeScreeningDecisions(
      [
        { taskId: 't1', decision: { keep: true, baselinePasses: 1, attempts: 2, ungradeable: false } },
        { taskId: 't2', decision: { keep: false, baselinePasses: 2, attempts: 2, ungradeable: false } },
      ],
      { model: 'claude-haiku-4-5-20251001', repeats: 2, screenedAt: '2026-07-31T00:00:00.000Z' },
    );
    const screened = applyScreeningResults(set, receipts, summary);
    await writeScreenedTaskSet(dir, screened);

    const reloaded = await loadTaskSet(dir); // throws on sha256 mismatch — this IS the assertion
    expect(reloaded.sha256).toBe(set.sha256);
    expect(reloaded.tasks.find((t) => t.id === 't1')!.screening).toEqual(receipts.get('t1'));
    expect(reloaded.tasks.find((t) => t.id === 't2')!.screening).toEqual(receipts.get('t2'));
    expect(reloaded.screeningSummary).toEqual(summary);
    // membership is unchanged — the dropped task ('t2') is still present, just keep:false.
    expect(reloaded.tasks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// run-bench task filtering (selectTasksForMeasurement)
// ---------------------------------------------------------------------------

describe('selectTasksForMeasurement — run-bench discrimination-gate filter', () => {
  it('runs every task unfiltered, with a warning, when the set carries no screening receipts at all', () => {
    const tasks = [task({ id: 't1' }), task({ id: 't2' })];
    const warnings: string[] = [];
    const selected = selectTasksForMeasurement(tasks, { includeScreenedOut: false, warn: (m) => warnings.push(m) });
    expect(selected).toEqual(tasks);
    expect(warnings.some((w) => /no screening receipts/.test(w))).toBe(true);
  });

  it('honors keep flags once screening receipts are present', () => {
    const tasks = [
      task({ id: 'keep-me', screening: receipt({ keep: true }) }),
      task({ id: 'drop-me', screening: receipt({ keep: false }) }),
    ];
    const selected = selectTasksForMeasurement(tasks, { includeScreenedOut: false, warn: () => {} });
    expect(selected.map((t) => t.id)).toEqual(['keep-me']);
  });

  it('--include-screened-out overrides the filter, with a loud warning', () => {
    const tasks = [
      task({ id: 'keep-me', screening: receipt({ keep: true }) }),
      task({ id: 'drop-me', screening: receipt({ keep: false }) }),
    ];
    const warnings: string[] = [];
    const selected = selectTasksForMeasurement(tasks, { includeScreenedOut: true, warn: (m) => warnings.push(m) });
    expect(selected.map((t) => t.id).sort()).toEqual(['drop-me', 'keep-me']);
    expect(warnings.some((w) => /include-screened-out/.test(w))).toBe(true);
  });

  it('throws when every task was screened out and there is no override', () => {
    const tasks = [task({ id: 'drop-me', screening: receipt({ keep: false }) })];
    expect(() => selectTasksForMeasurement(tasks, { includeScreenedOut: false, warn: () => {} }))
      .toThrow(/every task in this set was screened out/);
  });
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

describe('screen-task-set parseArgs', () => {
  it('applies defaults: repeats=2, passThreshold=1, out=<task-set>/.screening-run', () => {
    const cfg = parseArgs(['--task-set', '/tmp/tdd', '--model', 'claude-haiku-4-5-20251001']);
    expect(cfg.repeats).toBe(2);
    expect(cfg.passThreshold).toBe(1);
    expect(cfg.outDir.endsWith('/.screening-run')).toBe(true);
  });

  it('requires --task-set and --model', () => {
    expect(() => parseArgs(['--model', 'claude-haiku-4-5-20251001'])).toThrow(/--task-set is required/);
    expect(() => parseArgs(['--task-set', '/tmp/tdd'])).toThrow(/--model is required/);
  });

  it('rejects an out-of-range --pass-threshold', () => {
    expect(() => parseArgs(['--task-set', '/tmp/tdd', '--model', 'm', '--pass-threshold', '0'])).toThrow(/--pass-threshold must be in \(0, 1\]/);
    expect(() => parseArgs(['--task-set', '/tmp/tdd', '--model', 'm', '--pass-threshold', '1.5'])).toThrow(/--pass-threshold must be in \(0, 1\]/);
  });

  it('rejects a non-positive --repeats', () => {
    expect(() => parseArgs(['--task-set', '/tmp/tdd', '--model', 'm', '--repeats', '0'])).toThrow(/--repeats must be a positive integer/);
  });
});
