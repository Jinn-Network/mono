/**
 * Manual annex workflow (spec §3.1 step 6/7, `reeval-guard.ts`): after a
 * human has written the private annex from `list-failing-sessions.ts`'s
 * working set, this records the task ids that working set covered as
 * "burned" for the skill's lineage in `<repoRoot>/bench/reeval-ledger.json`
 * — no future re-evaluation of any sha of this skill may measure on them
 * (`assertReevalTasksFresh`, wired into `run-bench.ts --reeval-of`).
 *
 * `--skill` must name a treatment arm present in `<run>/bench-manifest.json`
 * with a non-null `skillSha256` — that sha is recorded on the ledger entry
 * for audit (which revision's annex burned which tasks), though the
 * freshness check itself scopes purely by skill name, not sha (a later
 * revision must avoid tasks burned by an earlier one too).
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/record-annex.ts \
 *     --run ../bench/runs/tdd-pilot --skill tdd --tasks fix-widget-0001,fix-widget-0004
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BenchManifest } from '../../src/skills-bench/attempts.js';
import { recordAnnexDerivation } from '../../src/skills-bench/reeval-guard.js';

// client/scripts/skills-bench/record-annex.ts -> client/scripts/skills-bench -> client/scripts -> client -> repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

// ---------------------------------------------------------------------------
// Pure arm-resolution logic — no filesystem. Extracted (final-review
// recommendation) so this CLI's one integrity-sensitive check — a mistyped
// --skill must fail loud, not silently under-burn the ledger — is directly
// unit-testable, the same pattern list-failing-sessions.ts uses for
// selectFailingSessions.
// ---------------------------------------------------------------------------

/** Resolves `skill` to a treatment arm (non-null `skillSha256`) in `manifest`,
 *  or throws naming the arms actually available. `manifestPath` is only used
 *  to compose the error message. */
export function resolveTreatmentArm(
  manifest: BenchManifest, skill: string, manifestPath: string,
): { name: string; skillSha256: string } {
  const arm = manifest.arms.find((a) => a.name === skill);
  if (!arm || !arm.skillSha256) {
    throw new Error(
      `no treatment arm named '${skill}' with a skillSha256 in ${manifestPath} — available arms: ` +
      manifest.arms.map((a) => a.name).join(', '),
    );
  }
  return { name: arm.name, skillSha256: arm.skillSha256 };
}

async function main(): Promise<void> {
  const runDir = resolve(arg('run'));
  const skill = arg('skill');
  const taskIds = arg('tasks').split(',').map((s) => s.trim()).filter(Boolean);
  if (taskIds.length === 0) throw new Error('--tasks must list at least one task id (comma-separated)');

  const manifestPath = join(runDir, 'bench-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BenchManifest;
  const arm = resolveTreatmentArm(manifest, skill, manifestPath);

  const ledgerFile = join(repoRoot, 'bench', 'reeval-ledger.json');
  const at = new Date().toISOString();
  await recordAnnexDerivation(ledgerFile, { skill, skillSha: arm.skillSha256, runDir, taskIds, at });
  console.log(
    `[record-annex] burned ${taskIds.length} task id(s) for '${skill}'@${arm.skillSha256} lineage in ${ledgerFile}: ` +
    taskIds.join(', '),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
