import { describe, expect, it } from 'vitest';
import { buildReceipt, renderReceiptMd } from '../../src/skills-bench/receipt.js';
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
});
