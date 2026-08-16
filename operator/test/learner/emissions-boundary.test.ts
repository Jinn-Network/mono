import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Invariant 2 (#1019): the graded score (gradedScore / gradedScores / passedCount
 * / totalCount) is consumed ONLY by the learning loop, never by any
 * emissions/reward/distribution code path. Until the withheld-test challenge
 * ships, a graded score must not size on-chain reward.
 *
 * Two match tiers, scoped to control false positives without sacrificing teeth:
 *
 *   TIER 1 — UNAMBIGUOUS identifiers `gradedScore` / `gradedScores`.
 *     These are Lever-A-specific and don't collide with any pre-existing field
 *     name, so we scan BROADLY: the core emissions dirs PLUS the full api/ and
 *     cli/ trees. This gives the guard real future teeth — a NEW emissions
 *     endpoint (e.g. api/rewards-v2.ts) that reads gradedScore is caught even
 *     though it doesn't exist yet. The broad scan currently has no legitimate
 *     `gradedScores` user outside learner/ — the one that used to be excluded,
 *     cli/commands/codedigest-revert-check.ts, was retired by one-swap R3b
 *     (issue #2494), so its exclusion row was removed with it.
 *
 *   TIER 2 — GENERIC counts `passedCount` / `totalCount`.
 *     These collide with unrelated fields (e.g. StorageSummary.totalCount in
 *     api/operator-artifacts-endpoint.ts), so we scan ONLY the core emissions
 *     dirs (earning/, distribution/) — never api/, cli/, or daemon/.
 */

// Resolve operator/src relative to this test file's location regardless of CWD.
// This file lives at operator/test/learner/emissions-boundary.test.ts
// → go up two levels to reach the client root, then into src/.
const thisFile = fileURLToPath(import.meta.url);
const clientRoot = join(dirname(thisFile), '..', '..'); // operator/
const srcRoot = join(clientRoot, 'src');

/**
 * Recursively walk a directory, returning all *.ts file paths (absolute).
 * Returns [] for a directory that does not exist (e.g. distribution/ before it ships).
 */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

// Shared exclusions for both tiers.
const isExcluded = (f: string): boolean =>
  f.includes('/learner/') || // graded scores ARE consumed here — by design
  f.endsWith('.test.ts');

// Core emissions/reward dirs — fully scanned by BOTH tiers.
const CORE_DIRS = ['earning', 'distribution'];

// Broader dirs — scanned by TIER 1 ONLY (unambiguous identifiers).
// daemon/ holds reward-claim-loop.ts; api/ and cli/ are full app surfaces where a
// future reward endpoint/command could land.
const TIER1_EXTRA_DIRS = ['daemon', 'api', 'cli'];

// TIER 1 file set: core dirs + broader dirs.
const tier1Files = [...CORE_DIRS, ...TIER1_EXTRA_DIRS]
  .flatMap((dir) => walk(join(srcRoot, dir)))
  .filter((f) => !isExcluded(f));

// TIER 2 file set: core dirs only.
const tier2Files = CORE_DIRS.flatMap((dir) => walk(join(srcRoot, dir))).filter(
  (f) => !isExcluded(f),
);

const UNAMBIGUOUS_RE = /\bgradedScore(s)?\b/;
const GENERIC_COUNTS_RE = /\bpassedCount\b|\btotalCount\b/;

describe('graded-score emissions boundary', () => {
  it('tier 1 scans a non-trivial number of files across emissions + api/cli (guard against renamed dirs)', () => {
    // api/ and cli/ alone push this well past any small threshold; if it ever
    // collapses, a directory was renamed — update CORE_DIRS / TIER1_EXTRA_DIRS.
    expect(tier1Files.length).toBeGreaterThan(20);
  });

  it('tier 2 scans the core emissions dirs (guard against renamed dirs)', () => {
    expect(tier2Files.length).toBeGreaterThan(0);
    // earning/ must be present — it is the primary on-chain reward surface.
    expect(tier2Files.some((f) => f.includes('/earning/'))).toBe(true);
  });

  it('tier 1: no emissions/reward/api/cli module references the unambiguous graded identifiers', () => {
    const offenders = tier1Files.filter((f) =>
      UNAMBIGUOUS_RE.test(readFileSync(f, 'utf8')),
    );
    expect(
      offenders,
      `gradedScore(s) leaked into an emissions/api/cli module: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('tier 2: no core emissions module references the generic count fields', () => {
    const offenders = tier2Files.filter((f) =>
      GENERIC_COUNTS_RE.test(readFileSync(f, 'utf8')),
    );
    expect(
      offenders,
      `passedCount/totalCount leaked into a core emissions module: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
