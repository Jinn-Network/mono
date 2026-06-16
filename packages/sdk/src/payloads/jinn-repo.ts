/**
 * jinn-repo Solution + Verdict payload schemas.
 *
 * Solution: the unified-diff patch the Solver's harness produced for the
 * jinn-repo instance (a real merged Jinn-Network/mono PR). Mirrors the
 * swe-rebench-v2 Solution shape; trajectory provenance is pinned via the
 * envelope, not the payload.
 *
 * Verdict: the repo-native test runner's pass/fail, with an optional log
 * excerpt for human inspection. The full test log is surfaced via the
 * envelope's `artifacts[]` rather than as a typed payload field.
 */

import { z } from 'zod/v3';

export const JinnRepoSolutionPayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-solution.v1'),
  patch: z.string().min(1),
});

export type JinnRepoSolutionPayload = z.infer<typeof JinnRepoSolutionPayloadSchema>;

export const JinnRepoVerdictPayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-verdict.v1'),
  passed: z.boolean(),
  test_log_excerpt: z.string().optional(),
});

export type JinnRepoVerdictPayload = z.infer<typeof JinnRepoVerdictPayloadSchema>;
