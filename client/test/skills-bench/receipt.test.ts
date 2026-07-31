import { describe, expect, it } from 'vitest';
import { buildReceipt, renderReceiptMd, summarizeTriggerRate } from '../../src/skills-bench/receipt.js';
import type { BenchOutcome } from '../../src/skills-bench/attempts.js';

function o(id: string, arm: string, passed: boolean | null, costUsd = 0.1): BenchOutcome {
  return { instanceId: id, arm, repeat: 0, passed, unscorable: passed === null, costUsd };
}

const profile = {
  model: 'claude-sonnet-5', agent: 'claude-code',
  slateSha256: 'deadbeef', slateHalf: 'both' as const, measuredOn: '2026-08-01',
};

describe('buildReceipt', () => {
  it('pairs per instance, excludes unscorable pairs, computes Wilson bounds', () => {
    const outcomes = [
      o('a', 'baseline', true),  o('a', 'tdd', true),   // concordant pass
      o('b', 'baseline', false), o('b', 'tdd', true),   // improved
      o('c', 'baseline', true),  o('c', 'tdd', false),  // regressed
      o('d', 'baseline', false), o('d', 'tdd', false),  // concordant fail
      o('e', 'baseline', null),  o('e', 'tdd', true),   // excluded (unscorable pair)
    ];
    const r = buildReceipt(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd', profile });
    expect(r.n).toBe(4);
    expect(r.excluded).toBe(1);
    expect(r.paired.improved).toBe(1);
    expect(r.paired.regressed).toBe(1);
    expect(r.baseline.passed).toBe(2);
    expect(r.treatment.passed).toBe(2);
    expect(r.baseline.lo).toBeGreaterThan(0);
    expect(r.baseline.hi).toBeLessThan(1);
  });
});

describe('buildReceipt with --repeats > 1', () => {
  function oR(id: string, arm: string, repeat: number, passed: boolean | null): BenchOutcome {
    return { instanceId: id, arm, repeat, passed, unscorable: passed === null, costUsd: 0.1 };
  }

  it('treats (instanceId, repeat) as the paired unit — repeats never collapse or double-count', () => {
    // 2 instances x 2 repeats x 2 arms, outcomes differ per repeat within an instance.
    const outcomes = [
      oR('a', 'baseline', 0, false), oR('a', 'tdd', 0, true),   // improved
      oR('a', 'baseline', 1, true), oR('a', 'tdd', 1, true),    // concordant pass
      oR('b', 'baseline', 0, true), oR('b', 'tdd', 0, false),   // regressed
      oR('b', 'baseline', 1, false), oR('b', 'tdd', 1, false),  // concordant fail
    ];
    const r = buildReceipt(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd', profile });
    // n must count the 4 (instanceId, repeat) pairs, not the 2 distinct instances.
    expect(r.n).toBe(4);
    expect(r.excluded).toBe(0);
    // improved/regressed must match the per-repeat pairing (one of each), not
    // collapse to whatever the last repeat per instance happened to be.
    expect(r.paired.improved).toBe(1);
    expect(r.paired.regressed).toBe(1);
    // passed/scorable must be consistent with n (4 pairs) on both arms.
    expect(r.baseline.scorable).toBe(4);
    expect(r.treatment.scorable).toBe(4);
    expect(r.baseline.passed).toBe(2); // a#r1, b#r0
    expect(r.treatment.passed).toBe(2); // a#r0, a#r1
  });
});

describe('renderReceiptMd', () => {
  it('renders the receipt shape with the unconditional scope caveat', () => {
    const outcomes = [o('a', 'baseline', false), o('a', 'tdd', true)];
    const md = renderReceiptMd(
      buildReceipt(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd', profile }),
    );
    expect(md).toContain('skill:      tdd');
    expect(md).toContain('agent:      claude-code, claude-sonnet-5');
    expect(md).toContain('scope:      one agent configuration, one benchmark, this task list');
    expect(md).toContain('slate sha256: deadbeef');
    expect(md).not.toMatch(/significan/i); // no significance language, ever (small-N honesty)
  });

  it('renders skill bytes on the scope line when skillSha256 is present (final-review.md I7)', () => {
    const outcomes = [o('a', 'baseline', false), o('a', 'tdd', true)];
    const md = renderReceiptMd(
      buildReceipt(outcomes, {
        baselineArm: 'baseline',
        treatmentArm: 'tdd',
        profile: { ...profile, skillSha256: 'deadbeef'.repeat(8), skillSource: 'mattpocock/skills@abc123' },
      }),
    );
    expect(md).toContain(`skill bytes: sha256 ${'deadbeef'.repeat(8)} · source mattpocock/skills@abc123`);
  });

  it('omits the skill bytes line when skillSha256 is absent (wave-1 baseline arm has no skill)', () => {
    const outcomes = [o('a', 'baseline', false), o('a', 'tdd', true)];
    const md = renderReceiptMd(
      buildReceipt(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd', profile }),
    );
    expect(md).not.toContain('skill bytes:');
  });

  it('omits the trigger line entirely when no triggerRate was supplied', () => {
    const outcomes = [o('a', 'baseline', false), o('a', 'tdd', true)];
    const md = renderReceiptMd(
      buildReceipt(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd', profile }),
    );
    expect(md).not.toContain('trigger:');
  });

  it('renders the trigger: line with the known N/M count', () => {
    const outcomes = [o('a', 'baseline', false), o('a', 'tdd', true), o('b', 'baseline', true), o('b', 'tdd', false)];
    const md = renderReceiptMd(
      buildReceipt(outcomes, {
        baselineArm: 'baseline', treatmentArm: 'tdd', profile,
        triggerRate: { triggered: 1, total: 2, unknown: 0 },
      }),
    );
    expect(md).toContain('trigger:    skill loaded on 1/2 solved+failed attempts');
    expect(md).not.toContain('unknown');
  });

  it('renders the unknown count explicitly rather than folding it into either bucket', () => {
    const outcomes = [o('a', 'baseline', false), o('a', 'tdd', true)];
    const md = renderReceiptMd(
      buildReceipt(outcomes, {
        baselineArm: 'baseline', treatmentArm: 'tdd', profile,
        triggerRate: { triggered: 1, total: 2, unknown: 3 },
      }),
    );
    expect(md).toContain('trigger:    skill loaded on 1/2 solved+failed attempts (3 unknown — session not captured)');
  });

  it('adds the "not exercised" caveat when net effect is 0 and trigger rate is under 50%', () => {
    // baseline 1/2, treatment 1/2 -> net 0. Trigger rate 1/5 (20%) < 50%.
    const outcomes = [
      o('a', 'baseline', true), o('a', 'tdd', true),
      o('b', 'baseline', false), o('b', 'tdd', false),
    ];
    const md = renderReceiptMd(
      buildReceipt(outcomes, {
        baselineArm: 'baseline', treatmentArm: 'tdd', profile,
        triggerRate: { triggered: 1, total: 5, unknown: 0 },
      }),
    );
    expect(md).toMatch(/not exercised on this task set/);
  });

  it('does NOT add the "not exercised" caveat when net effect is 0 but trigger rate is high (a real null, not an unexercised skill)', () => {
    const outcomes = [
      o('a', 'baseline', true), o('a', 'tdd', true),
      o('b', 'baseline', false), o('b', 'tdd', false),
    ];
    const md = renderReceiptMd(
      buildReceipt(outcomes, {
        baselineArm: 'baseline', treatmentArm: 'tdd', profile,
        triggerRate: { triggered: 4, total: 5, unknown: 0 },
      }),
    );
    expect(md).not.toMatch(/not exercised on this task set/);
  });

  it('does NOT add the "not exercised" caveat when net effect is non-zero, regardless of trigger rate', () => {
    const outcomes = [
      o('a', 'baseline', false), o('a', 'tdd', true), // improved -> net +1
      o('b', 'baseline', false), o('b', 'tdd', false),
    ];
    const md = renderReceiptMd(
      buildReceipt(outcomes, {
        baselineArm: 'baseline', treatmentArm: 'tdd', profile,
        triggerRate: { triggered: 1, total: 5, unknown: 0 },
      }),
    );
    expect(md).not.toMatch(/not exercised on this task set/);
  });

  it('does NOT add the "not exercised" caveat when there is no known trigger data (total 0)', () => {
    const outcomes = [
      o('a', 'baseline', true), o('a', 'tdd', true),
      o('b', 'baseline', false), o('b', 'tdd', false),
    ];
    const md = renderReceiptMd(
      buildReceipt(outcomes, {
        baselineArm: 'baseline', treatmentArm: 'tdd', profile,
        triggerRate: { triggered: 0, total: 0, unknown: 4 },
      }),
    );
    expect(md).not.toMatch(/not exercised on this task set/);
  });
});

describe('summarizeTriggerRate', () => {
  it('counts triggered/total from known results and unknown separately, never folding unknown into either bucket', () => {
    const r = summarizeTriggerRate([
      { triggered: true }, { triggered: false }, { triggered: true }, { triggered: null }, { triggered: null },
    ]);
    expect(r).toEqual({ triggered: 2, total: 3, unknown: 2 });
  });

  it('returns all zeros for an empty result set', () => {
    expect(summarizeTriggerRate([])).toEqual({ triggered: 0, total: 0, unknown: 0 });
  });
});
