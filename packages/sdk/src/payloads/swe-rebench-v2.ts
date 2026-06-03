/**
 * SWE-rebench v2 Solution + Verdict payload schemas.
 *
 * Solution: the unified-diff patch the Solver's harness produced for the
 * benchmark instance. The Solver does not pin or reference its own
 * trajectory — the daemon's envelope-assembly path pins the trajectory
 * to IPFS and references it via the envelope-level
 * `SignedEnvelope.trajectory: TrajectoryRefSchema`. Keeping
 * trajectory-pinning out of the Solution payload preserves the
 * solver/daemon boundary (the Solver only knows what it can derive
 * from its own work).
 *
 * Cost (operator-self-reported) is generalisable across SolverNets.
 *
 * Verdict: deterministic test-suite pass/fail + grading provenance. The
 * test log is surfaced via the envelope's `artifacts[]` (with the
 * pinned-blob CID in the artifact's metadata) rather than as a typed
 * payload field, so daemon-derived IPFS provenance does not leak into
 * the Verdict schema.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.2
 */

import { z } from 'zod';

export const SweRebenchV2SolutionPayloadSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-solution.v1'),
  /** Unified diff patch (git-format). */
  patch: z.string().min(1),
  /**
   * Operator-self-reported cost of producing this Solution. Optional; when
   * present, contributes to the per-harness cost rollups. Generalisable
   * across SolverNets — only `totalUsd` is required at v1.
   */
  cost: z
    .object({
      totalUsd: z.number().nonnegative(),
      breakdown: z
        .object({
          llm: z.number().nonnegative().optional(),
          tools: z.number().nonnegative().optional(),
          other: z.number().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type SweRebenchV2SolutionPayload = z.infer<typeof SweRebenchV2SolutionPayloadSchema>;

export const SweRebenchV2VerdictV1PayloadSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-verdict.v1'),
  /** Pass@1 score: 1 if the test suite passed, 0 otherwise. */
  score: z.union([z.literal(0), z.literal(1)]),
  /**
   * Whether the actual passed/failed test set matched the expected
   * `FAIL_TO_PASS ∪ PASS_TO_PASS` exactly. False if extra tests passed
   * or expected tests failed unexpectedly.
   */
  passed_match: z.boolean(),
  /** Cost of running the evaluator on this Solution (USDC-equivalent). */
  evaluator_cost_usd: z.number().nonnegative(),
});

/**
 * v2 — additive graded signal (Lever A, #1019). Superset of v1: keeps the
 * binary `score`/`passed_match` (the objective) and adds the per-test counts
 * the grader already computes. `gradedScore = passedCount / totalCount` is
 * derived downstream, never stored, to keep one source of truth.
 */
export const SweRebenchV2VerdictV2PayloadSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-verdict.v2'),
  score: z.union([z.literal(0), z.literal(1)]),
  passed_match: z.boolean(),
  evaluator_cost_usd: z.number().nonnegative(),
  /** Count of individual tests that passed in this run. */
  passedCount: z.number().int().nonnegative(),
  /** Total gradeable tests in this run (FAIL_TO_PASS ∪ PASS_TO_PASS as the runner reported). */
  totalCount: z.number().int().nonnegative(),
}).refine((p) => p.passedCount <= p.totalCount, {
  message: 'passedCount must not exceed totalCount',
});

/** Accept either schema version on the read path. */
export const SweRebenchV2VerdictPayloadSchema = z.union([
  SweRebenchV2VerdictV1PayloadSchema,
  SweRebenchV2VerdictV2PayloadSchema,
]);

export type SweRebenchV2VerdictV1Payload = z.infer<typeof SweRebenchV2VerdictV1PayloadSchema>;
export type SweRebenchV2VerdictV2Payload = z.infer<typeof SweRebenchV2VerdictV2PayloadSchema>;
export type SweRebenchV2VerdictPayload = z.infer<typeof SweRebenchV2VerdictPayloadSchema>;
