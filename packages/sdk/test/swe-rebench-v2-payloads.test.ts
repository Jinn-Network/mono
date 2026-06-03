import { describe, it, expect } from 'vitest';
import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
  SweRebenchV2VerdictV2PayloadSchema,
} from '../src/payloads/swe-rebench-v2.js';

describe('SweRebenchV2SolutionPayloadSchema', () => {
  it('accepts a minimal Solution', () => {
    const sol = {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-hello\n+world\n',
    };
    expect(() => SweRebenchV2SolutionPayloadSchema.parse(sol)).not.toThrow();
  });

  it('accepts an optional cost field', () => {
    const sol = {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: '...',
      cost: { totalUsd: 0.42 },
    };
    expect(() => SweRebenchV2SolutionPayloadSchema.parse(sol)).not.toThrow();
  });

  it('rejects a Solution missing patch', () => {
    const sol = { schemaVersion: 'swe-rebench-v2-solution.v1' };
    expect(() => SweRebenchV2SolutionPayloadSchema.parse(sol)).toThrow();
  });

  it('does not require trajectory_cid (daemon fills in trajectory provenance via the envelope)', () => {
    const sol = {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff ...',
    };
    expect(() => SweRebenchV2SolutionPayloadSchema.parse(sol)).not.toThrow();
  });
});

describe('SweRebenchV2VerdictPayloadSchema', () => {
  it('accepts a passing Verdict (score 1, passed_match true)', () => {
    const v = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 1,
      passed_match: true,
      evaluator_cost_usd: 0.05,
    };
    expect(() => SweRebenchV2VerdictPayloadSchema.parse(v)).not.toThrow();
  });

  it('accepts a failing Verdict (score 0)', () => {
    const v = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 0,
      passed_match: false,
      evaluator_cost_usd: 0.05,
    };
    expect(() => SweRebenchV2VerdictPayloadSchema.parse(v)).not.toThrow();
  });

  it('rejects scores outside {0, 1}', () => {
    const v = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 0.5,
      passed_match: true,
      evaluator_cost_usd: 0.05,
    };
    expect(() => SweRebenchV2VerdictPayloadSchema.parse(v)).toThrow();
  });

  it('does not require test_log_cid (the test log is surfaced via envelope artifacts[] metadata)', () => {
    const v = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 1,
      passed_match: true,
      evaluator_cost_usd: 0,
    };
    expect(() => SweRebenchV2VerdictPayloadSchema.parse(v)).not.toThrow();
  });
});

describe('swe-rebench-v2-verdict.v2 (graded, additive)', () => {
  const v2 = {
    schemaVersion: 'swe-rebench-v2-verdict.v2' as const,
    score: 0 as const,
    passed_match: false,
    evaluator_cost_usd: 0,
    passedCount: 18,
    totalCount: 20,
  };

  it('parses a v2 verdict with graded counts', () => {
    const parsed = SweRebenchV2VerdictV2PayloadSchema.parse(v2);
    expect(parsed.passedCount).toBe(18);
    expect(parsed.totalCount).toBe(20);
  });

  it('rejects negative or non-integer counts', () => {
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({ ...v2, passedCount: -1 })).toThrow();
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({ ...v2, totalCount: 1.5 })).toThrow();
  });

  it('rejects passedCount greater than totalCount', () => {
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({ ...v2, passedCount: 21, totalCount: 20 })).toThrow();
  });

  it('accepts passedCount === totalCount (all tests pass)', () => {
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({ ...v2, passedCount: 20, totalCount: 20 })).not.toThrow();
  });

  it('accepts the (0,0) no-gradeable-tests boundary', () => {
    // Downstream treats totalCount===0 as gradedScore=null (design §7), so the
    // schema stays permissive and does not reject the zero-gradeable-test run.
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({ ...v2, passedCount: 0, totalCount: 0 })).not.toThrow();
  });

  it('union accepts both v1 and v2', () => {
    const v1 = { schemaVersion: 'swe-rebench-v2-verdict.v1' as const, score: 1 as const, passed_match: true, evaluator_cost_usd: 0 };
    expect(SweRebenchV2VerdictPayloadSchema.parse(v1).schemaVersion).toBe('swe-rebench-v2-verdict.v1');
    expect(SweRebenchV2VerdictPayloadSchema.parse(v2).schemaVersion).toBe('swe-rebench-v2-verdict.v2');
  });
});
