/**
 * Re-evaluation freshness guard (spec §3.1 step 7 of
 * docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md, v0.2):
 * "if the author revises the skill, measure the revision on a fresh,
 * previously-unseen task set (or a held-back portion of the original ~20
 * candidates) — never on the tasks the diagnosis was derived from... keyed
 * to `skill@sha` lineage instead of a candidate id: diagnosis tasks are
 * burned for that lineage, fresh or held-back tasks serve the
 * re-evaluation."
 *
 * Mirrors `holdout-guard.ts`'s ledger shape and one-shot-refusal posture,
 * re-keyed for a different unit: holdout-guard blocks a second *run* against
 * a fixed candidate id; this guard blocks re-*measuring* on task ids a prior
 * annex diagnosis already read. Scoping is deliberately by `skill` (the
 * lineage identity), not by `skillSha` — a revision mints a new sha, but the
 * whole point of "burned for the lineage" is that the burn survives the
 * revision: a task the diagnosis for v1 was derived from stays off-limits
 * for measuring v2, v3, etc. of the same skill. `skillSha` is recorded per
 * entry for audit only (which revision's annex burned which tasks), never
 * used to scope the freshness check.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AnnexDerivation {
  skill: string;
  skillSha: string;
  runDir: string;
  taskIds: string[];
  at: string;
}

export interface ReevalLedger {
  version: 'reeval-ledger.v1';
  derivations: AnnexDerivation[];
}

async function loadLedger(file: string): Promise<ReevalLedger> {
  if (!existsSync(file)) return { version: 'reeval-ledger.v1', derivations: [] };
  return JSON.parse(await readFile(file, 'utf8')) as ReevalLedger;
}

/** Records that the task ids whose transcripts informed a private-annex
 *  diagnosis (`list-failing-sessions.ts`'s working set) are now burned for
 *  `skill`'s lineage: no future re-evaluation of any sha of this skill may
 *  measure on them. Append-only — a skill measured multiple times over its
 *  life accumulates one entry per annex, and `assertReevalTasksFresh` unions
 *  every recorded entry for the skill regardless of which sha burned it. */
export async function recordAnnexDerivation(ledgerFile: string, entry: AnnexDerivation): Promise<void> {
  const ledger = await loadLedger(ledgerFile);
  ledger.derivations.push(entry);
  await mkdir(dirname(ledgerFile), { recursive: true });
  await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Every task id burned for `skill`'s lineage, across every recorded
 *  derivation (any sha), deduped and sorted for stable error messages. */
export function burnedTaskIds(ledger: ReevalLedger, skill: string): string[] {
  const set = new Set<string>();
  for (const d of ledger.derivations) {
    if (d.skill !== skill) continue;
    for (const id of d.taskIds) set.add(id);
  }
  return [...set].sort();
}

/** Throws, listing the overlap, if any of `taskIds` was already burned for
 *  `skill`'s lineage (by any prior annex derivation, any sha). A clean throw
 *  is the point — the caller (run-bench.ts's `--reeval-of`) is expected to
 *  let this abort the run rather than catch and continue; `--force-reeval`
 *  is the loud, explicit override (see run-bench.ts), not a parameter here. */
export async function assertReevalTasksFresh(
  ledgerFile: string,
  opts: { skill: string; taskIds: string[] },
): Promise<void> {
  const ledger = await loadLedger(ledgerFile);
  const burned = new Set(burnedTaskIds(ledger, opts.skill));
  const overlap = opts.taskIds.filter((id) => burned.has(id));
  if (overlap.length > 0) {
    throw new Error(
      `re-evaluation of '${opts.skill}' would measure on ${overlap.length} task(s) already burned for ` +
      `this lineage by a prior annex diagnosis: ${overlap.join(', ')} — a re-evaluation must run on ` +
      `tasks the diagnosis was never derived from (spec §3.1 step 7). Use a fresh or held-back task set, ` +
      `or pass --force-reeval to override (loud, not recommended).`,
    );
  }
}
