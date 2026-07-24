/**
 * jinn-repo Solution + Verdict payload schemas.
 *
 * Solution: the unified-diff patch the Solver's harness produced for the
 * jinn-repo instance (a real merged Jinn-Network/mono PR, or a prospective
 * live GitHub issue — see `source` on the Task schema). Mirrors the
 * swe-rebench-v2 Solution shape; trajectory provenance is pinned via the
 * envelope, not the payload.
 *
 * Verdict: two schema versions, keyed to the Task's `source`:
 *   - v1: merged-pr grading — the repo-native gold FAIL_TO_PASS test runner's
 *     pass/fail, with an optional log excerpt for human inspection.
 *   - v2 (issue #1891): live-issue grading — no gold tests exist
 *     prospectively, so the mechanical evaluator grades three gates (patch
 *     applies, typecheck, policy-scoped tests) instead. Additive over v1:
 *     keeps `passed`/`test_log_excerpt` and adds `gates`. Mirrors the
 *     swe-rebench-v2-verdict.v1 → .v2 additive precedent in
 *     `./swe-rebench-v2.ts`.
 *
 * The full test log is surfaced via the envelope's `artifacts[]` rather than
 * as a typed payload field on either version.
 */

import { z } from 'zod/v3';

export const JinnRepoSolutionPayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-solution.v1'),
  patch: z.string().min(1),
});

export type JinnRepoSolutionPayload = z.infer<typeof JinnRepoSolutionPayloadSchema>;

export const JinnRepoVerdictV1PayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-verdict.v1'),
  passed: z.boolean(),
  test_log_excerpt: z.string().optional(),
});

export type JinnRepoVerdictV1Payload = z.infer<typeof JinnRepoVerdictV1PayloadSchema>;

/**
 * v2 — mechanical evaluator for live-issue (no-gold) tasks (issue #1891).
 * `gates` records the three-stage grade the live-eval-runner computes
 * (applies → typecheck → tests, each AND-gated into `passed`).
 */
export const JinnRepoVerdictV2PayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-verdict.v2'),
  passed: z.boolean(),
  test_log_excerpt: z.string().optional(),
  gates: z.object({
    applies: z.boolean(),
    typecheck: z.boolean(),
    tests: z.boolean(),
  }),
});

export type JinnRepoVerdictV2Payload = z.infer<typeof JinnRepoVerdictV2PayloadSchema>;

/** Accept either schema version on the read path. */
export const JinnRepoVerdictPayloadSchema = z.union([
  JinnRepoVerdictV1PayloadSchema,
  JinnRepoVerdictV2PayloadSchema,
]);

export type JinnRepoVerdictPayload = z.infer<typeof JinnRepoVerdictPayloadSchema>;
