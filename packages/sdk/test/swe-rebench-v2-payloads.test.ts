import { describe, it, expect } from 'vitest';
import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
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
