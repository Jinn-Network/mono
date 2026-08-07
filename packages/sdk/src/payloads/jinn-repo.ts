/**
 * jinn-repo Solution + Verdict payload schemas.
 *
 * Solution: either the legacy unified-diff patch produced for a merged-PR or
 * live-issue task, or the strict typed mutation result produced for an
 * Autopilot session.
 *
 * Verdict: legacy mechanical versions plus the strict Autopilot review result:
 *   - v1: merged-pr grading — the repo-native gold FAIL_TO_PASS test runner's
 *     pass/fail, with an optional log excerpt for human inspection.
 *   - v2 (issue #1891): live-issue grading — no gold tests exist
 *     prospectively, so the mechanical evaluator grades three gates (patch
 *     applies, typecheck, policy-scoped tests) instead. Additive over v1:
 *     keeps `passed`/`test_log_excerpt` and adds `gates`. Mirrors the
 *     swe-rebench-v2-verdict.v1 → .v2 additive precedent in
 *     `./swe-rebench-v2.ts`.
 *   - jinn-autopilot-review-result.v1: semantic exact-head review outcomes.
 *
 * The full test log is surfaced via the envelope's `artifacts[]` rather than
 * as a typed payload field on the legacy mechanical versions.
 */

import { z } from 'zod/v3';
import {
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
} from '../autopilot-session.js';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayVerdictV1Schema,
} from '../issue-relay.js';
import { JinnRepoApplicationRefSchema } from '../jinn-repo.js';

const JinnRepoApplicationPayloadFields = {
  schemaVersion: z.literal('jinn-repo-application-payload.v1'),
  application: JinnRepoApplicationRefSchema,
  payload: z.record(z.string(), z.unknown()),
};

export const JinnRepoApplicationSolutionPayloadSchema = z.object({
  ...JinnRepoApplicationPayloadFields,
  role: z.literal('solution'),
}).strict();

export const JinnRepoApplicationVerdictPayloadSchema = z.object({
  ...JinnRepoApplicationPayloadFields,
  role: z.literal('verdict'),
  /** Generic marketplace settlement projection; applications own the evidence behind it. */
  projection: z.enum(['pass', 'fail', 'unresolved']),
}).strict();

export type JinnRepoApplicationSolutionPayload = z.infer<
  typeof JinnRepoApplicationSolutionPayloadSchema
>;
export type JinnRepoApplicationVerdictPayload = z.infer<
  typeof JinnRepoApplicationVerdictPayloadSchema
>;

export const JinnRepoLegacySolutionPayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-solution.v1'),
  patch: z.string().min(1),
});

export const JinnRepoAutopilotSolutionPayloadSchema = AutopilotMutationResultSchema;

export const JinnRepoIssueRelayAdoptionPayloadSchema =
  IssueRelayAdoptionReceiptV1Schema;

export const JinnRepoSolutionPayloadSchema = z.union([
  JinnRepoLegacySolutionPayloadSchema,
  JinnRepoApplicationSolutionPayloadSchema,
  JinnRepoAutopilotSolutionPayloadSchema,
  JinnRepoIssueRelayAdoptionPayloadSchema,
]);

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
  JinnRepoApplicationVerdictPayloadSchema,
  AutopilotReviewResultSchema,
  IssueRelayVerdictV1Schema,
]);

export const JinnRepoAutopilotVerdictPayloadSchema = AutopilotReviewResultSchema;

export const JinnRepoIssueRelayVerdictPayloadSchema = IssueRelayVerdictV1Schema;

export type JinnRepoVerdictPayload = z.infer<typeof JinnRepoVerdictPayloadSchema>;
