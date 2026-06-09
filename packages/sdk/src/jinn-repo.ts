/**
 * jinn-repo Task schema. Represents a real merged GitHub PR from the
 * Jinn-Network/mono repo as a coding task: the instance is defined by the PR
 * that introduced the fix, and the FAIL_TO_PASS gold is the PR's own test
 * files.
 *
 * Mirrors the daemon-side schema at `client/src/solver-types/jinn-repo.ts`;
 * the SDK keeps its own copy so SolverNet contract definitions can reference
 * it without the SDK importing from the client.
 */

import { z } from 'zod';

export const JINN_REPO_SCHEMA_VERSION = 'jinn-repo.v1' as const;

export const JinnRepoTaskSchema = z.object({
  schemaVersion: z.literal(JINN_REPO_SCHEMA_VERSION),
  instance_id: z.string().min(1),
  repo: z.literal('Jinn-Network/mono'),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  merged_pr: z.number().int().positive(),
  language: z.literal('typescript'),
  problem_statement: z.string().min(1),
  // The PR's own test files — the FAIL_TO_PASS gold. A task with none is ungradeable.
  test_files: z.array(z.string().min(1)).min(1),
  // The exact command the evaluator runs (scoped to test_files).
  test_cmd: z.string().min(1),
});

export type JinnRepoTask = z.infer<typeof JinnRepoTaskSchema>;
