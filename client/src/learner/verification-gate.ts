/**
 * Verification gate for knowledge adoption (#1396, part of #1392).
 *
 * Classifies a `getCodeDigestRewards` row (#764) into
 * `verified | suggested | insufficient` so the #1393 loader can prefer
 * network-verified artifacts and only ever *suggest* unverified ones — never
 * auto-adopt them.
 *
 * `minPassRate` 0.5 = a strict majority of verdicted attempts passed.
 */

import type { CodeDigestRewardRow, DiscoveryAPI } from '../discovery/types.js';
import { DiscoveryUnavailableError } from '../discovery/types.js';

export interface VerificationPolicy {
  /** Min in-window verdicted attempts before a codeDigest can be 'verified'. Default 5. */
  minVerifiedAttempts: number;
  /** Min pass rate to count as 'verified'. Default 0.5 = a strict majority of verdicted attempts passed. */
  minPassRate: number;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  minVerifiedAttempts: 5,
  minPassRate: 0.5,
};

/** Merge a partial policy over the defaults (mirrors `resolveRevertPolicy`). */
export function resolveVerificationPolicy(override?: Partial<VerificationPolicy>): VerificationPolicy {
  return { ...DEFAULT_VERIFICATION_POLICY, ...(override ?? {}) };
}

export type VerificationStatus = 'verified' | 'suggested' | 'insufficient';

export type VerificationReason =
  | 'passed_threshold'
  | 'below_pass_rate'
  | 'below_min_sample'
  | 'no_verdicts';

export interface VerificationVerdict {
  codeDigest: string;
  status: VerificationStatus;
  /** Evidence the decision rested on, copied from the #764 verdict↔codeDigest join. */
  evidence: { attempts: number; passes: number; passRate: number; avgScore: number };
  reason: VerificationReason;
}

/**
 * Pure classifier: maps a single `getCodeDigestRewards` row (or its absence) to
 * a verification verdict. `verified` requires ≥ `minVerifiedAttempts` in-window
 * verdicts AND `passRate ≥ minPassRate`. Verdicts present but under either bar →
 * `suggested`. No indexed verdicts (`row === undefined`) → `insufficient`.
 */
export function classifyVerification(
  row: CodeDigestRewardRow | undefined,
  policy?: Partial<VerificationPolicy>,
): VerificationVerdict {
  const { minVerifiedAttempts, minPassRate } = resolveVerificationPolicy(policy);

  if (row === undefined) {
    return {
      codeDigest: '',
      status: 'insufficient',
      evidence: { attempts: 0, passes: 0, passRate: 0, avgScore: 0 },
      reason: 'no_verdicts',
    };
  }

  const base = {
    codeDigest: row.codeDigest,
    evidence: {
      attempts: row.attempts,
      passes: row.passes,
      passRate: row.passRate,
      avgScore: row.avgScore,
    },
  };

  if (row.attempts < minVerifiedAttempts) {
    return { ...base, status: 'suggested', reason: 'below_min_sample' };
  }
  if (row.passRate < minPassRate) {
    return { ...base, status: 'suggested', reason: 'below_pass_rate' };
  }
  return { ...base, status: 'verified', reason: 'passed_threshold' };
}

/**
 * Async convenience over the existing #764 join. Queries verdicts for one
 * `codeDigest` (optionally scoped to a SolverNet / capped to a recent window)
 * and classifies the single row. Returns `insufficient` on a degraded indexer
 * (`DiscoveryUnavailableError`) rather than throwing, so the loader's
 * "never blocks the claim/solve path" guarantee holds for free.
 */
export async function classifyCodeDigest(
  discovery: DiscoveryAPI,
  codeDigest: string,
  opts?: { solverNetManifestCid?: string; window?: number; policy?: Partial<VerificationPolicy> },
): Promise<VerificationVerdict> {
  let rows: CodeDigestRewardRow[];
  try {
    rows = await discovery.getCodeDigestRewards({
      codeDigests: [codeDigest],
      solverNetManifestCid: opts?.solverNetManifestCid,
      window: opts?.window,
    });
  } catch (err) {
    if (err instanceof DiscoveryUnavailableError) {
      const verdict = classifyVerification(undefined, opts?.policy);
      return { ...verdict, codeDigest };
    }
    throw err;
  }

  const row = rows.find((r) => r.codeDigest === codeDigest);
  const verdict = classifyVerification(row, opts?.policy);
  return { ...verdict, codeDigest };
}
