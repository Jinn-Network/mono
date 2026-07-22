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

  it('maps admission-path docker_credentials_error to infra-blocked', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [{
        instance_id: 'x',
        reason: 'ungradeable:docker_credentials_error',
      }],
    });
    expect(result.classification).toBe('infra-blocked');
    expect(result.hypothesisHolds).toBeNull();
  });

  it('maps insufficient-disk rejection message to infra-blocked', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [{
        instance_id: 'x',
        reason: 'insufficient disk for swe-rebench eval: 16.2 GB free, need ≥ 20.0 GB',
      }],
    });
    expect(result.classification).toBe('infra-blocked');
    expect(result.hypothesisHolds).toBeNull();
  });

  it('classifies gold-patch-not-resolved as rejected:other (inconclusive)', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [{
        instance_id: 'x',
        reason: 'gold-patch-not-resolved (f2p 0, p2p_broke 0)',
      }],
    });
    expect(result.classification).toBe('rejected:other');
    expect(result.hypothesisHolds).toBeNull();
  });

  it('classifies non-dead product rejection as rejected:other', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [{ instance_id: 'x', reason: 'patch_does_not_apply' }],
    });
    expect(result.classification).toBe('rejected:other');
    expect(result.hypothesisHolds).toBeNull();
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
