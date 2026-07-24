/**
 * jinn-repo Task schema. A discriminated union on `source`:
 *   - `merged-pr` (retrospective): a real merged GitHub PR from the
 *     Jinn-Network/mono repo — the instance is defined by the PR that
 *     introduced the fix, and the FAIL_TO_PASS gold is the PR's own test
 *     files.
 *   - `live-issue` (prospective): an open GitHub issue on Jinn-Network/mono,
 *     posted before a fix exists — no gold tests. See
 *     spec/2026-07-20-autopilot-marketplace-execution.md
 *     §"No new SolverType: a live variant of jinn-repo".
 *
 * `schemaVersion` stays `'jinn-repo.v1'` on both branches so corpus
 * knowledge autoload (keyed on solverType) keeps working across both.
 * Backward compatibility: a raw document with no `source` field is legacy
 * data and is treated as `source: 'merged-pr'`.
 *
 * Mirrors the daemon-side schema at `client/src/solver-types/jinn-repo.ts`;
 * the SDK keeps its own copy so SolverNet contract definitions can reference
 * it without the SDK importing from the client.
 */

import { z } from 'zod/v3';

export const JINN_REPO_SCHEMA_VERSION = 'jinn-repo.v1' as const;

const commonFields = {
  schemaVersion: z.literal(JINN_REPO_SCHEMA_VERSION),
  instance_id: z.string().min(1),
  repo: z.literal('Jinn-Network/mono'),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  language: z.literal('typescript'),
  problem_statement: z.string().min(1),
};

// NOTE on strictness: these schemas deliberately do NOT call `.strict()` —
// mirrors the daemon-side schema, which tolerates the CLI submit wrapper's
// unrelated keys (`id`, `description`, `solverType`, `spec`) via zod's
// default "strip" mode. The two oracle-field groups are instead declared as
// `z.never().optional()` on the branch they must never appear on, so a
// genuine cross-branch leak (e.g. `merged_pr` on a live-issue task) is a
// hard validation error rather than silent stripping.

export const JinnRepoMergedPrTaskSchema = z.object({
  ...commonFields,
  source: z.literal('merged-pr').default('merged-pr'),
  merged_pr: z.number().int().positive(),
  // The PR's own test files — the FAIL_TO_PASS gold. A task with none is ungradeable.
  test_files: z.array(z.string().min(1)).min(1),
  // The exact command the evaluator runs (scoped to test_files).
  test_cmd: z.string().min(1),
  // Live-issue-only fields — never valid on a merged-pr task.
  issue_number: z.never().optional(),
  effort: z.never().optional(),
});

export const JinnRepoLiveIssueTaskSchema = z.object({
  ...commonFields,
  source: z.literal('live-issue'),
  // The open GitHub issue this task snapshots.
  issue_number: z.number().int().positive(),
  // The board's Effort field (reasoning-depth signal).
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  // Merged-pr-only gold-oracle fields — never valid on a live-issue task.
  merged_pr: z.never().optional(),
  test_files: z.never().optional(),
  test_cmd: z.never().optional(),
});

export const JinnRepoTaskSchema = z.preprocess((val) => {
  if (val !== null && typeof val === 'object' && !('source' in val)) {
    return { ...(val as Record<string, unknown>), source: 'merged-pr' };
  }
  return val;
}, z.discriminatedUnion('source', [JinnRepoMergedPrTaskSchema, JinnRepoLiveIssueTaskSchema]));

export type JinnRepoMergedPrTask = z.infer<typeof JinnRepoMergedPrTaskSchema>;
export type JinnRepoLiveIssueTask = z.infer<typeof JinnRepoLiveIssueTaskSchema>;
export type JinnRepoTask = JinnRepoMergedPrTask | JinnRepoLiveIssueTask;

/** Narrows a `JinnRepoTask` to the retrospective (merged-PR, gold-tested) branch. */
export function isMergedPrTask(task: JinnRepoTask): task is JinnRepoMergedPrTask {
  return task.source === 'merged-pr';
}

/** Narrows a `JinnRepoTask` to the prospective (live-issue, no-gold) branch. */
export function isLiveIssueTask(task: JinnRepoTask): task is JinnRepoLiveIssueTask {
  return task.source === 'live-issue';
}
