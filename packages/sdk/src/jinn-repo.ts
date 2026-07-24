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
 *   - `autopilot-session`: an immutable Autopilot V2 session capsule for a
 *     marketplace-backed implementation or repair workflow.
 *
 * `schemaVersion` stays `'jinn-repo.v1'` on every branch so corpus
 * knowledge autoload (keyed on solverType) keeps working across both.
 * Backward compatibility: a raw document with no `source` field is legacy
 * data and is treated as `source: 'merged-pr'`.
 *
 * Mirrors the daemon-side schema at `client/src/solver-types/jinn-repo.ts`;
 * the SDK keeps its own copy so SolverNet contract definitions can reference
 * it without the SDK importing from the client.
 */

import { z } from 'zod/v3';
import {
  AutopilotSafeTokenSchema,
  AutopilotSessionCapsuleSchema,
  GitHubRepositorySlugSchema,
} from './autopilot-session.js';

export const JINN_REPO_SCHEMA_VERSION = 'jinn-repo.v1' as const;

const sharedFields = {
  schemaVersion: z.literal(JINN_REPO_SCHEMA_VERSION),
  instance_id: z.string().min(1),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  problem_statement: z.string().min(1),
};

const legacyCommonFields = {
  ...sharedFields,
  repo: z.literal('Jinn-Network/mono'),
  language: z.literal('typescript'),
  verificationProfile: z.never().optional(),
};

// NOTE on strictness: these schemas deliberately do NOT call `.strict()` —
// mirrors the daemon-side schema, which tolerates the CLI submit wrapper's
// unrelated keys (`id`, `description`, `solverType`, `spec`) via zod's
// default "strip" mode. Branch-only fields are instead declared as
// `z.never().optional()` on the branches where they must never appear, so a
// genuine cross-branch leak (e.g. `merged_pr` on a live-issue task) is a
// hard validation error rather than silent stripping.

export const JinnRepoMergedPrTaskSchema = z.object({
  ...legacyCommonFields,
  source: z.literal('merged-pr').default('merged-pr'),
  merged_pr: z.number().int().positive(),
  // The PR's own test files — the FAIL_TO_PASS gold. A task with none is ungradeable.
  test_files: z.array(z.string().min(1)).min(1),
  // The exact command the evaluator runs (scoped to test_files).
  test_cmd: z.string().min(1),
  // Live-issue-only fields — never valid on a merged-pr task.
  issue_number: z.never().optional(),
  effort: z.never().optional(),
  session: z.never().optional(),
});

export const JinnRepoLiveIssueTaskSchema = z.object({
  ...legacyCommonFields,
  source: z.literal('live-issue'),
  // The open GitHub issue this task snapshots.
  issue_number: z.number().int().positive(),
  // The board's Effort field (reasoning-depth signal).
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  // Merged-pr-only gold-oracle fields — never valid on a live-issue task.
  merged_pr: z.never().optional(),
  test_files: z.never().optional(),
  test_cmd: z.never().optional(),
  session: z.never().optional(),
});

const autopilotSessionTaskFields = {
  ...sharedFields,
  repo: GitHubRepositorySlugSchema,
  language: AutopilotSafeTokenSchema,
  verificationProfile: AutopilotSafeTokenSchema,
  source: z.literal('autopilot-session'),
  session: AutopilotSessionCapsuleSchema,
  // Existing branch-only fields are never valid on an Autopilot session.
  merged_pr: z.never().optional(),
  test_files: z.never().optional(),
  test_cmd: z.never().optional(),
  issue_number: z.never().optional(),
  effort: z.never().optional(),
};

const JinnRepoAutopilotSessionTaskObjectSchema = z.object(
  autopilotSessionTaskFields,
);

type AutopilotSessionTaskShape = z.infer<
  typeof JinnRepoAutopilotSessionTaskObjectSchema
>;

function requireAutopilotSessionBindings(
  task: AutopilotSessionTaskShape,
  ctx: z.RefinementCtx,
): void {
  const bindings = [
    ['repo', task.repo, task.session.repository],
    ['language', task.language, task.session.language],
    [
      'verificationProfile',
      task.verificationProfile,
      task.session.verificationProfile,
    ],
  ] as const;
  for (const [field, outer, inner] of bindings) {
    if (outer !== inner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message:
          `${field} must match session.`
          + `${field === 'repo' ? 'repository' : field}`,
      });
    }
  }
}

export const JinnRepoAutopilotSessionTaskSchema = z.object(
  autopilotSessionTaskFields,
).strict().superRefine(requireAutopilotSessionBindings);

export const JinnRepoTaskSchema = z.preprocess((val) => {
  if (val !== null && typeof val === 'object' && !('source' in val)) {
    return { ...(val as Record<string, unknown>), source: 'merged-pr' };
  }
  return val;
}, z.discriminatedUnion('source', [
  JinnRepoMergedPrTaskSchema,
  JinnRepoLiveIssueTaskSchema,
  JinnRepoAutopilotSessionTaskObjectSchema,
])).superRefine((task, ctx) => {
  if (task.source !== 'autopilot-session') return;
  requireAutopilotSessionBindings(task, ctx);
});

export type JinnRepoMergedPrTask = z.infer<typeof JinnRepoMergedPrTaskSchema>;
export type JinnRepoLiveIssueTask = z.infer<typeof JinnRepoLiveIssueTaskSchema>;
export type JinnRepoAutopilotSessionTask = z.infer<
  typeof JinnRepoAutopilotSessionTaskSchema
>;
export type JinnRepoTask =
  | JinnRepoMergedPrTask
  | JinnRepoLiveIssueTask
  | JinnRepoAutopilotSessionTask;

/** Narrows a `JinnRepoTask` to the retrospective (merged-PR, gold-tested) branch. */
export function isMergedPrTask(task: JinnRepoTask): task is JinnRepoMergedPrTask {
  return task.source === 'merged-pr';
}

/** Narrows a `JinnRepoTask` to the prospective (live-issue, no-gold) branch. */
export function isLiveIssueTask(task: JinnRepoTask): task is JinnRepoLiveIssueTask {
  return task.source === 'live-issue';
}

/** Narrows a `JinnRepoTask` to the marketplace-backed Autopilot session branch. */
export function isAutopilotSessionTask(
  task: JinnRepoTask,
): task is JinnRepoAutopilotSessionTask {
  return task.source === 'autopilot-session';
}
