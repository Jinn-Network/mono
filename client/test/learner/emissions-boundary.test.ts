import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Invariant 2 (#1019): the graded score (gradedScore / gradedScores / passedCount
 * / totalCount) is consumed ONLY by the learning loop, never by any
 * emissions/reward/distribution code path. Until the withheld-test challenge
 * ships, a graded score must not size on-chain reward.
 */

// Resolve client/src relative to this test file's location regardless of CWD.
// This file lives at client/test/learner/emissions-boundary.test.ts
// → go up three levels to reach the client root, then into src/.
const thisFile = fileURLToPath(import.meta.url);
const clientRoot = join(dirname(thisFile), '..', '..'); // client/
const srcRoot = join(clientRoot, 'src');

/**
 * Recursively walk a directory, returning all *.ts file paths (absolute).
 */
function walk(dir: string): string[] {
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

/**
 * Collect emissions/reward/distribution source files.
 *
 * Scanned directories (all under client/src/):
 *   - earning/         — wallet, bootstrap, reward-claim helpers (fully scanned)
 *   - x402/            — payment-gated artifact access (fully scanned)
 *   - daemon/          — reward-claim-loop.ts and sibling loops (fully scanned)
 *
 * Specific reward files picked by name from broader dirs:
 *   - api/rewards-build.ts
 *   - cli/commands/rewards.ts, cli/commands/claim-rewards.ts
 *   - mcp/get-codedigest-reward.ts
 *
 * Rationale for picking specific files rather than scanning whole api/ / cli/ / mcp/:
 * Those directories contain hundreds of non-reward files. Scanning them whole introduces
 * false positives — e.g., `operator-artifacts-endpoint.ts` has a `totalCount` field in
 * an unrelated StorageSummary type; `codedigest-revert-check.ts` is the learning-loop's
 * revert-check CLI tool (not an emissions path). We target only the files that actually
 * participate in reward calculation or distribution.
 *
 * Exclusions (not emissions sinks):
 *   - paths containing /learner/      — that IS where graded scores are consumed
 *   - files matching codedigest-reward — MCP read-only helper, not a reward emitter
 *   - *.test.ts files
 */
const dirsToScan = ['earning', 'x402', 'daemon'];

const specificRewardFiles = [
  join(srcRoot, 'api', 'rewards-build.ts'),
  join(srcRoot, 'cli', 'commands', 'rewards.ts'),
  join(srcRoot, 'cli', 'commands', 'claim-rewards.ts'),
  join(srcRoot, 'mcp', 'get-codedigest-reward.ts'),
].filter((f) => {
  try { statSync(f); return true; } catch { return false; }
});

const emissionsFiles = [
  ...dirsToScan.flatMap((dir) => {
    const full = join(srcRoot, dir);
    return walk(full);
  }),
  ...specificRewardFiles,
].filter(
  (f) =>
    !f.includes('/learner/') &&
    !f.includes('codedigest-reward') &&
    !f.endsWith('.test.ts'),
);

const GRADED_FIELDS_RE = /\bgradedScore(s)?\b|\bpassedCount\b|\btotalCount\b/;

describe('graded-score emissions boundary', () => {
  it('scans a non-trivial number of emissions/reward files (guard against empty glob)', () => {
    // If this fails, the directory structure was renamed — update dirsToScan above.
    expect(emissionsFiles.length).toBeGreaterThan(5);
  });

  it('includes earning/ files in the scanned set', () => {
    const earningFiles = emissionsFiles.filter((f) => f.includes('/earning/'));
    expect(earningFiles.length).toBeGreaterThan(0);
  });

  it('no emissions/reward module references the graded fields', () => {
    const offenders = emissionsFiles.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return GRADED_FIELDS_RE.test(src);
    });
    expect(
      offenders,
      `graded fields leaked into emissions: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
