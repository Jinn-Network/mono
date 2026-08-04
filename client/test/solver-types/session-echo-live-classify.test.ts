import { describe, expect, it } from 'vitest';
import {
  DOCKER_INFO_TIMEOUT_MS,
  classifySessionEchoLiveResult,
  dockerPreflightError,
  isGradedSessionEchoLiveClassification,
  readSessionEchoLivePriorSummary,
  resolveSessionEchoLiveResultWrite,
  seedIsolatedValidatedPool,
  sessionEchoLiveProcessExitCode,
} from '../../src/solver-types/_swe-rebench-v2-session-echo-live-classify.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  it('does not hide an unexpected thrown error as an infrastructure block', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [],
      infraError: 'unexpected invariant violation',
    });
    expect(result.classification).toBe('rejected:other');
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

  it('maps an eval timeout rejection to infra-blocked', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-mismatch',
      admitted: [],
      rejected: [{
        instance_id: 'x',
        reason: 'transient:eval_timeout',
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

  it('treats empirical-dead under borrow-aligned as outside the mismatch hypothesis', () => {
    const result = classifySessionEchoLiveResult({
      mode: 'borrow-aligned',
      admitted: [],
      rejected: [{ instance_id: 'x', reason: 'empirical-dead: no FAIL_TO_PASS tests' }],
    });
    expect(result.classification).toBe('rejected:empirical-dead');
    expect(result.hypothesisHolds).toBeNull();
  });
});

describe('dockerPreflightError', () => {
  it('bounds docker info and reports an unresponsive daemon', () => {
    let observedTimeout: number | undefined;
    const result = dockerPreflightError((_args, options) => {
      observedTimeout = options.timeout;
      return { status: null, error: { code: 'ETIMEDOUT' } };
    });

    expect(observedTimeout).toBe(DOCKER_INFO_TIMEOUT_MS);
    expect(result).toMatch(/did not respond/);
  });
});

describe('isGradedSessionEchoLiveClassification', () => {
  it('treats every non-infra classification as graded', () => {
    expect(isGradedSessionEchoLiveClassification('admitted')).toBe(true);
    expect(isGradedSessionEchoLiveClassification('rejected:empirical-dead')).toBe(true);
    expect(isGradedSessionEchoLiveClassification('rejected:other')).toBe(true);
  });

  it('treats infra-blocked as ungraded', () => {
    expect(isGradedSessionEchoLiveClassification('infra-blocked')).toBe(false);
  });
});

describe('sessionEchoLiveProcessExitCode', () => {
  it('returns non-zero for red-flag admits', () => {
    expect(sessionEchoLiveProcessExitCode({
      classification: 'admitted',
      hypothesisHolds: false,
      redFlag: 'worse-than-hypothesized',
    })).toBe(1);
  });

  it('returns non-zero for infra-blocked classifications', () => {
    expect(sessionEchoLiveProcessExitCode({
      classification: 'infra-blocked',
      hypothesisHolds: null,
    })).toBe(1);
  });

  it('returns zero for graded non-red outcomes', () => {
    expect(sessionEchoLiveProcessExitCode({
      classification: 'rejected:empirical-dead',
      hypothesisHolds: true,
    })).toBe(0);
    expect(sessionEchoLiveProcessExitCode({
      classification: 'rejected:other',
      hypothesisHolds: null,
    })).toBe(0);
  });
});

describe('readSessionEchoLivePriorSummary', () => {
  it('returns null when the canonical artifact is missing', () => {
    expect(readSessionEchoLivePriorSummary('/tmp/missing-session-echo-live-result.json')).toBeNull();
  });

  it('reads the prior classification from the canonical artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-echo-live-read-'));
    const path = join(dir, 'session-echo-live-result.json');
    writeFileSync(path, JSON.stringify({ classification: 'rejected:other' }));
    expect(readSessionEchoLivePriorSummary(path)).toEqual({
      classification: 'rejected:other',
    });
  });
});

describe('resolveSessionEchoLiveResultWrite', () => {
  const canonicalPath = '/operator/swe-rebench-v2/session-echo-live-result.json';

  it('writes to the canonical path when there is no prior graded SoR', () => {
    expect(resolveSessionEchoLiveResultWrite({
      canonicalPath,
      classified: { classification: 'infra-blocked', hypothesisHolds: null },
      prior: null,
      timestamp: '2026-07-24T12-00-00-000Z',
    })).toEqual({
      resultPath: canonicalPath,
      preservedPriorGradedSoR: false,
    });
  });

  it('preserves a prior graded SoR by writing infra-blocked attempts to a timestamped path', () => {
    expect(resolveSessionEchoLiveResultWrite({
      canonicalPath,
      classified: { classification: 'infra-blocked', hypothesisHolds: null },
      prior: { classification: 'rejected:other' },
      timestamp: '2026-07-24T12-00-00-000Z',
    })).toEqual({
      resultPath: '/operator/swe-rebench-v2/session-echo-live-result-2026-07-24T12-00-00-000Z.json',
      preservedPriorGradedSoR: true,
    });
  });

  it('overwrites an ungraded prior infra-blocked artifact', () => {
    expect(resolveSessionEchoLiveResultWrite({
      canonicalPath,
      classified: { classification: 'infra-blocked', hypothesisHolds: null },
      prior: { classification: 'infra-blocked' },
      timestamp: '2026-07-24T12-00-00-000Z',
    })).toEqual({
      resultPath: canonicalPath,
      preservedPriorGradedSoR: false,
    });
  });

  it('overwrites a prior graded SoR with a new graded result', () => {
    expect(resolveSessionEchoLiveResultWrite({
      canonicalPath,
      classified: { classification: 'rejected:empirical-dead', hypothesisHolds: true },
      prior: { classification: 'rejected:other' },
      timestamp: '2026-07-24T12-00-00-000Z',
    })).toEqual({
      resultPath: canonicalPath,
      preservedPriorGradedSoR: false,
    });
  });
});

describe('seedIsolatedValidatedPool', () => {
  it('copies the operator pool into the temporary live-verify state directory', () => {
    const copies: Array<{ source: string; destination: string }> = [];
    const stateDir = seedIsolatedValidatedPool(
      '/operator/validated-pool.json',
      '/tmp/session-echo-live-123',
      (source, destination) => copies.push({ source, destination }),
    );

    expect(stateDir).toBe('/tmp/session-echo-live-123');
    expect(copies).toEqual([{
      source: '/operator/validated-pool.json',
      destination: '/tmp/session-echo-live-123/validated-pool.json',
    }]);
  });
});
