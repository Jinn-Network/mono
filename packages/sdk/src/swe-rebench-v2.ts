/**
 * SWE-rebench v2 Task schema. The on-chain JinnRouter Task payload references
 * a HuggingFace dataset row by `(hf_dataset, hf_split, instance_id)`; the
 * Solver and Evaluator fetch the full row at solve / grade time.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.3
 */

import { z } from 'zod/v3';

export const SweRebenchV2LanguageSchema = z.enum([
  'python', 'javascript', 'typescript', 'go',
  'c', 'cpp', 'cs', 'java', 'rust', 'dart',
]);

export const SweRebenchV2TaskSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2.v1'),
  /**
   * The SWE-rebench v2 instance identifier. Format: <org>__<repo>-<issue-or-pr-number>,
   * e.g. "unidata__netcdf-c-1925".
   */
  instance_id: z.string().min(1),
  /** GitHub repo path (org/repo). */
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  /** Git commit SHA at which the issue was reported. */
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** Programming language of the underlying repo. */
  language: SweRebenchV2LanguageSchema,
  /** Issue or PR description. */
  problem_statement: z.string(),
  /**
   * v2 auxiliary interface info (function names, signatures, descriptions for
   * touched symbols). Empty string when no interface is provided.
   */
  interface: z.string(),
  /** HuggingFace dataset id, e.g. 'nebius/SWE-rebench-leaderboard'. */
  hf_dataset: z.string().regex(/^[^/]+\/[^/]+$/),
  /** HF split identifier, e.g. '2026_02'. */
  hf_split: z.string().regex(/^\d{4}_\d{2}$/),
  /** Unix epoch (seconds) deadline for Solution submission. */
  deadline_unix: z.number().int().positive(),
  /**
   * Round identifier for the launched SolverNet manifest. Format YYYY-MM.
   * Used for per-round dashboard rollups and per-round reward distribution.
   */
  round_month: z.string().regex(/^\d{4}-\d{2}$/),
});

export type SweRebenchV2Task = z.infer<typeof SweRebenchV2TaskSchema>;
