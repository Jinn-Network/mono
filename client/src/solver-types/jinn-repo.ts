/**
 * jinn-repo SolverType task schema.
 *
 * A discriminated union on `source`:
 *   - `merged-pr` (retrospective): a real merged GitHub PR from the
 *     Jinn-Network/mono repo. The instance is defined by the PR that
 *     introduced the fix; the FAIL_TO_PASS gold is the PR's own test files.
 *   - `live-issue` (prospective): an open GitHub issue on Jinn-Network/mono,
 *     posted before a fix exists. No gold tests — grading is Stage 1's thin
 *     mechanical evaluator (patch applies, typecheck, policy-scoped tests),
 *     not FAIL_TO_PASS exact-match. See
 *     spec/2026-07-20-autopilot-marketplace-execution.md
 *     §"No new SolverType: a live variant of jinn-repo".
 *
 * `schemaVersion` stays `'jinn-repo.v1'` on both branches and the solverType
 * string is unchanged — corpus knowledge autoload keys on solverType, so
 * merged-PR-mined knowledge continues to autoload into live solves.
 *
 * Backward compatibility: a raw document with no `source` field is legacy
 * data and is treated as `source: 'merged-pr'` (the only branch that existed
 * before this union).
 */

import { z } from 'zod';

export const JINN_REPO_SCHEMA_VERSION = 'jinn-repo.v1' as const;

const commonFields = {
  schemaVersion: z.literal(JINN_REPO_SCHEMA_VERSION),
  instance_id: z.string().min(1),
  repo: z.literal('Jinn-Network/mono'),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  language: z.literal('typescript'),
  problem_statement: z.string().min(1),
};

// NOTE on strictness: these schemas deliberately do NOT call `.strict()`.
// `jinn tasks submit --spec-file` (client/src/cli/commands/tasks.ts) parses
// the raw JSON file, then merges it with CLI-level fields (`id`,
// `description`, `solverType`, a possibly-empty `spec`) before handing the
// merged object to `parseSpec` → `JinnRepoTaskSchema.parse`. `.strict()`
// would reject that wrapper on those unrelated keys. Default zod "strip"
// mode tolerates them (as the pre-union schema always did), while the two
// oracle-field groups below are explicitly declared as `z.never().optional()`
// on the branch they must never appear on — so a genuine cross-branch leak
// (e.g. `merged_pr` smuggled onto a live-issue task) is a hard validation
// error rather than being silently stripped like unrelated CLI noise.

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
  // The open GitHub issue this task snapshots. Issues are mutable; the task
  // freezes `problem_statement` at post time — material issue edits cancel
  // and re-post, they never mutate the posted task.
  issue_number: z.number().int().positive(),
  // The board's Effort field (reasoning-depth signal), carried through to
  // the solver harness in place of the coordinator session's effortFlag.
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  // Merged-pr-only gold-oracle fields — never valid on a live-issue task (no
  // gold tests exist prospectively).
  merged_pr: z.never().optional(),
  test_files: z.never().optional(),
  test_cmd: z.never().optional(),
});

/**
 * Public task schema: a discriminated union on `source`, with backward
 * compatibility for legacy documents that predate the `source` field —
 * those are preprocessed to `source: 'merged-pr'` before routing to the
 * matching branch schema.
 */
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
