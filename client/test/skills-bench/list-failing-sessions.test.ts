import { describe, expect, it } from 'vitest';
import { selectFailingSessions } from '../../scripts/skills-bench/list-failing-sessions.js';
import type { BenchOutcome } from '../../src/skills-bench/attempts.js';

function o(id: string, arm: string, repeat: number, passed: boolean | null): BenchOutcome {
  return { instanceId: id, arm, repeat, passed, unscorable: passed === null, costUsd: 0.1 };
}

describe('selectFailingSessions', () => {
  it('excludes a resolved treatment attempt entirely', () => {
    const outcomes = [o('t1', 'baseline', 0, false), o('t1', 'tdd', 0, true)];
    expect(selectFailingSessions(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd' })).toEqual([]);
  });

  it('labels a treatment failure against a resolved baseline as "regressed"', () => {
    const outcomes = [o('t1', 'baseline', 0, true), o('t1', 'tdd', 0, false)];
    expect(selectFailingSessions(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd' })).toEqual([
      { taskId: 't1', repeat: 0, outcomeLabel: 'regressed' },
    ]);
  });

  it('labels a concordant failure (baseline also failed) as "failed", not "regressed"', () => {
    const outcomes = [o('t1', 'baseline', 0, false), o('t1', 'tdd', 0, false)];
    expect(selectFailingSessions(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd' })).toEqual([
      { taskId: 't1', repeat: 0, outcomeLabel: 'failed' },
    ]);
  });

  it('labels a treatment failure with no paired baseline attempt as "failed"', () => {
    const outcomes = [o('t1', 'tdd', 0, false)];
    expect(selectFailingSessions(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd' })).toEqual([
      { taskId: 't1', repeat: 0, outcomeLabel: 'failed' },
    ]);
  });

  it('labels an ungradeable treatment attempt as "ungradeable" regardless of the baseline outcome', () => {
    const outcomes = [o('t1', 'baseline', 0, true), o('t1', 'tdd', 0, null)];
    expect(selectFailingSessions(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd' })).toEqual([
      { taskId: 't1', repeat: 0, outcomeLabel: 'ungradeable' },
    ]);
  });

  it('pairs by (instanceId, repeat), not instanceId alone — repeats never cross-contaminate', () => {
    const outcomes = [
      o('t1', 'baseline', 0, true), o('t1', 'tdd', 0, false), // regressed
      o('t1', 'baseline', 1, false), o('t1', 'tdd', 1, false), // concordant fail
    ];
    const result = selectFailingSessions(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd' });
    expect(result).toEqual([
      { taskId: 't1', repeat: 0, outcomeLabel: 'regressed' },
      { taskId: 't1', repeat: 1, outcomeLabel: 'failed' },
    ]);
  });

  it('ignores baseline-arm and unrelated-arm outcomes as selection candidates', () => {
    const outcomes = [
      o('t1', 'baseline', 0, false), // baseline failing on its own is never listed
      o('t2', 'other-arm', 0, false),
    ];
    expect(selectFailingSessions(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd' })).toEqual([]);
  });

  it('sorts results by taskId then repeat, independent of input order', () => {
    const outcomes = [
      o('b', 'tdd', 1, false),
      o('a', 'tdd', 0, false),
      o('b', 'tdd', 0, false),
    ];
    const result = selectFailingSessions(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd' });
    expect(result.map((r) => `${r.taskId}#${r.repeat}`)).toEqual(['a#0', 'b#0', 'b#1']);
  });
});
