import { describe, it, expect, vi } from 'vitest';
import {
  classifyVerification,
  classifyCodeDigest,
  resolveVerificationPolicy,
  DEFAULT_VERIFICATION_POLICY,
} from '../../src/learner/verification-gate.js';
import {
  DiscoveryUnavailableError,
  type CodeDigestRewardRow,
  type DiscoveryAPI,
} from '../../src/discovery/types.js';

/** Fixture builder for a CodeDigestRewardRow (the #764 verdict↔codeDigest join output). */
function row(over: Partial<CodeDigestRewardRow> = {}): CodeDigestRewardRow {
  return {
    codeDigest: 'sha256:A',
    attempts: 10,
    passes: 8,
    passRate: 0.8,
    avgScore: 0.6,
    gradedScores: [],
    ...over,
  };
}

describe('classifyVerification (pure) — #1396 AC2', () => {
  it('exposes the documented default thresholds (no magic numbers)', () => {
    expect(DEFAULT_VERIFICATION_POLICY.minVerifiedAttempts).toBe(5);
    expect(DEFAULT_VERIFICATION_POLICY.minPassRate).toBe(0.5);
  });

  it('verified: >= min sample AND passRate >= bar', () => {
    const v = classifyVerification(row({ attempts: 10, passes: 8, passRate: 0.8 }));
    expect(v.status).toBe('verified');
    expect(v.codeDigest).toBe('sha256:A');
  });

  it('verified: exactly at both thresholds', () => {
    const v = classifyVerification(row({ attempts: 5, passes: 3, passRate: 0.6 }));
    expect(v.status).toBe('verified');
  });

  it('verified: passRate exactly at the 0.5 bar (>= boundary)', () => {
    const v = classifyVerification(row({ attempts: 6, passes: 3, passRate: 0.5 }));
    expect(v.status).toBe('verified');
  });

  it('suggested: enough attempts but passRate under bar', () => {
    const v = classifyVerification(row({ attempts: 10, passes: 3, passRate: 0.3 }));
    expect(v.status).toBe('suggested');
  });

  it('suggested: passRate over bar but too few attempts (under min sample)', () => {
    const v = classifyVerification(row({ attempts: 2, passes: 2, passRate: 1.0 }));
    expect(v.status).toBe('suggested');
  });

  it('insufficient: no verdicts (row undefined)', () => {
    const v = classifyVerification(undefined);
    expect(v.status).toBe('insufficient');
    expect(v.evidence).toEqual({ attempts: 0, passes: 0, passRate: 0, avgScore: 0 });
  });

  it('evidence carries the real row fields verbatim (attempts, passes, passRate, avgScore)', () => {
    const v = classifyVerification(
      row({ attempts: 10, passes: 8, passRate: 0.8, avgScore: 0.72 }),
    );
    expect(v.evidence).toEqual({ attempts: 10, passes: 8, passRate: 0.8, avgScore: 0.72 });
  });

  it('policy override: raising minPassRate to 0.9 flips a 0.8 row from verified to suggested', () => {
    const r = row({ attempts: 10, passes: 8, passRate: 0.8 });
    expect(classifyVerification(r).status).toBe('verified');
    expect(classifyVerification(r, { minPassRate: 0.9 }).status).toBe('suggested');
  });

  it('resolveVerificationPolicy merges overrides over defaults', () => {
    expect(resolveVerificationPolicy()).toEqual(DEFAULT_VERIFICATION_POLICY);
    expect(resolveVerificationPolicy({ minVerifiedAttempts: 20 })).toEqual({
      minVerifiedAttempts: 20,
      minPassRate: 0.5,
    });
  });
});

describe('classifyCodeDigest (async discovery wrapper) — #1396 AC2', () => {
  it('verified round-trip: matching row from getCodeDigestRewards', async () => {
    const discovery = {
      getCodeDigestRewards: vi.fn(async () => [
        row({ codeDigest: 'sha256:X', attempts: 10, passes: 8, passRate: 0.8 }),
      ]),
    } as unknown as DiscoveryAPI;
    const v = await classifyCodeDigest(discovery, 'sha256:X');
    expect(v.status).toBe('verified');
    expect(v.codeDigest).toBe('sha256:X');
  });

  it('insufficient: codeDigest absent from result (empty array)', async () => {
    const discovery = {
      getCodeDigestRewards: vi.fn(async () => []),
    } as unknown as DiscoveryAPI;
    const v = await classifyCodeDigest(discovery, 'sha256:MISSING');
    expect(v.status).toBe('insufficient');
    expect(v.codeDigest).toBe('sha256:MISSING');
  });

  it('discovery outage: DiscoveryUnavailableError -> insufficient (never throws)', async () => {
    const discovery = {
      getCodeDigestRewards: vi.fn(async () => {
        throw new DiscoveryUnavailableError('down');
      }),
    } as unknown as DiscoveryAPI;
    const v = await classifyCodeDigest(discovery, 'sha256:X');
    expect(v.status).toBe('insufficient');
  });

  it('rethrows non-DiscoveryUnavailable errors', async () => {
    const discovery = {
      getCodeDigestRewards: vi.fn(async () => {
        throw new Error('unexpected');
      }),
    } as unknown as DiscoveryAPI;
    await expect(classifyCodeDigest(discovery, 'sha256:X')).rejects.toThrow('unexpected');
  });

  it('passes solverNetManifestCid / window / codeDigest through to the query', async () => {
    const getCodeDigestRewards = vi.fn(async () => []);
    const discovery = { getCodeDigestRewards } as unknown as DiscoveryAPI;
    await classifyCodeDigest(discovery, 'sha256:X', {
      solverNetManifestCid: 'bafyManifest',
      window: 200,
    });
    expect(getCodeDigestRewards).toHaveBeenCalledWith({
      codeDigests: ['sha256:X'],
      solverNetManifestCid: 'bafyManifest',
      window: 200,
    });
  });

  it('threads a policy override through the wrapper', async () => {
    const discovery = {
      getCodeDigestRewards: vi.fn(async () => [
        row({ codeDigest: 'sha256:X', attempts: 10, passes: 8, passRate: 0.8 }),
      ]),
    } as unknown as DiscoveryAPI;
    const v = await classifyCodeDigest(discovery, 'sha256:X', { policy: { minPassRate: 0.9 } });
    expect(v.status).toBe('suggested');
  });
});
