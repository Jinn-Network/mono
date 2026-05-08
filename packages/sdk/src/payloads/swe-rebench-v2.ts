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

export const SweRebenchV2VerdictPayloadSchema = z.object({
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

export type SweRebenchV2VerdictPayload = z.infer<typeof SweRebenchV2VerdictPayloadSchema>;
