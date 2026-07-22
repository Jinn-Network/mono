import { describe, expect, it } from 'vitest';
import {
  classifySessionEchoLiveResult,
} from '../../src/solver-types/_swe-rebench-v2-session-echo-live-classify.js';

describe('classifySessionEchoLiveResult', () => {
  it('classifies empirical-dead rejection as rejected:empirical-dead', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [{ instance_id: 'sympy__sympy__session-aaaaaaaaaaaa', reason: 'empirical-dead: no FAIL_TO_PASS tests' }],
    });
    expect(result.classification).toBe('rejected:empirical-dead');
    expect(result.hypothesisHolds).toBe(true);
    expect(result.redFlag).toBeUndefined();
  });

  it('flags admit under borrow-mismatch as worse-than-hypothesized', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: ['sympy__sympy__session-bbbbbbbbbbbb'],
      rejected: [],
    });
    expect(result.classification).toBe('admitted');
    expect(result.hypothesisHolds).toBe(false);
    expect(result.redFlag).toMatch(/worse-than-hypothesized/);
  });

  it('treats infraError as infra-blocked with null hypothesis', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [],
      infraError: 'Docker daemon not reachable',
    });
    expect(result.classification).toBe('infra-blocked');
    expect(result.hypothesisHolds).toBeNull();
  });

  it('classifies non-dead rejection as rejected:other', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [{ instance_id: 'x', reason: 'patch_does_not_apply' }],
    });
    expect(result.classification).toBe('rejected:other');
    expect(result.hypothesisHolds).toBe(false);
  });

  it('treats admit under borrow-aligned as expected (no red flag)', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-aligned',
      admitted: ['sympy__sympy__session-cccccccccccc'],
      rejected: [],
    });
    expect(result.classification).toBe('admitted');
    expect(result.hypothesisHolds).toBeNull();
    expect(result.redFlag).toBeUndefined();
  });
});
