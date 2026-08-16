/**
 * Captured-task schema — the raw, pre-scrub input to the harness capture path.
 *
 * Extracted from the former client harness layer in C2 (#1833):
 * the parse half of capture.ts has no scrub / `operator/src` dependency (only
 * zod + the two envelope enums), so it moved into `@jinn-network/core`.
 * C5 subsequently moved the scrub implementation alongside it while leaving
 * capture orchestration in the layer.
 */
import { z } from 'zod';
import {
  EvidenceProvenanceSchema,
  OutcomeStatusSchema,
  VerifiabilityTierSchema,
} from './envelope.js';

/** Unix-nanosecond timestamp string (OTel span convention). */
const UnixNanoSchema = z.string().regex(/^\d+$/, 'unix-nanosecond digit string');

const F2pP2pVerifierSchema = z.strictObject({
  type: z.literal('f2p-p2p'),
  failToPass: z.array(z.string().min(1)),
  passToPass: z.array(z.string().min(1)),
  evalSemanticsVersion: z.string().min(1),
});

const OtherVerifierSchema = z.strictObject({
  type: z.enum(['command', 'none']),
  failToPass: z.array(z.string().min(1)).default([]),
  passToPass: z.array(z.string().min(1)).default([]),
  evalSemanticsVersion: z.string().min(1).optional(),
});

const CapturedVerifierSchema = z.discriminatedUnion('type', [
  F2pP2pVerifierSchema,
  OtherVerifierSchema,
]);

const CapturedStepEventSchema = z.strictObject({
  timeUnixNano: UnixNanoSchema,
  name: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const CapturedStepStatusSchema = z.strictObject({
  code: z.enum(['UNSET', 'OK', 'ERROR']),
  message: z.string().min(1).optional(),
});

/**
 * A captured task — the raw, pre-scrub input to `capture()`. Mirrors the
 * envelope shape minus `consent` (which does not exist pre-consent) with
 * UNSCRUBBED step attributes and no size caps (raw captures routinely exceed
 * them; the fitting rule applies to the conversion output, not the input).
 * Strict: a task file with unknown fields is malformed, not tolerated.
 */
export const CapturedTaskSchema = z.strictObject({
  session: z.strictObject({
    sessionId: z.string().min(1).max(128),
    capturedAt: z.iso.datetime(),
    kind: z.enum(['user', 'host-internal']).optional(),
    parentSessionId: z.string().min(1).max(128).optional(),
  }),
  task: z.strictObject({
    summary: z.string().min(1),
    distributionTags: z.array(z.string().min(1)).min(1),
    repositorySlug: z.string().min(1).optional(),
    baseCommit: z.string().min(1).optional(),
    createdAt: z.number().int().nonnegative().optional(),
    instanceId: z.string().min(1).optional(),
  }),
  environment: z.strictObject({
    harness: z.strictObject({
      name: z.string().min(1),
      version: z.string().min(1),
    }),
    model: z.string().min(1),
    tools: z.array(z.string().min(1)),
    skillsLoadout: z.array(z.string().min(1)).optional(),
    generatorModel: z.strictObject({
      id: z.string().min(1),
      provider: z.string().min(1).optional(),
      openWeights: z.boolean().optional(),
      source: z.enum(['stream', 'config']),
    }).optional(),
    distributionClass: z.enum(['open', 'restricted-tos', 'unknown']).optional(),
    verifier: CapturedVerifierSchema.optional(),
  }),
  steps: z.array(z.strictObject({
    spanId: z.string().min(1),
    parentSpanId: z.string().min(1).nullable(),
    name: z.string().min(1),
    kind: z.enum(['jinn.agent_turn', 'jinn.tool_call']).optional(),
    startTimeUnixNano: UnixNanoSchema,
    endTimeUnixNano: UnixNanoSchema,
    attributes: z.record(z.string(), z.unknown()),
    /** Keys already redacted at ingest, if the capture recorded any. */
    redactedKeys: z.array(z.string().min(1)).default([]),
    /** Optional canonical OTLP observations retained by richer transcript parsers. */
    events: z.array(CapturedStepEventSchema).optional(),
    status: CapturedStepStatusSchema.optional(),
  })).min(1),
  outcome: z.strictObject({
    status: OutcomeStatusSchema,
    verifiabilityTier: VerifiabilityTierSchema,
    summary: z.string().min(1).optional(),
  }),
  cost: z.strictObject({
    durationMs: z.number().int().nonnegative(),
    tokens: z.strictObject({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }).optional(),
    usdEstimate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  }),
  attemptGroup: z.strictObject({
    groupId: z.string().min(1),
    attemptId: z.string().min(1),
    relatedAttemptRefs: z.array(z.string().min(1)).default([]),
    groupSize: z.number().int().positive().optional(),
    nPass: z.number().int().nonnegative().optional(),
    nFail: z.number().int().nonnegative().optional(),
  }).optional(),
  lineage: z.strictObject({
    episodeId: z.string().min(1),
    mintRef: z.string().min(1).optional(),
  }).optional(),
  provenance: EvidenceProvenanceSchema.default('contributed'),
});
export type CapturedTask = z.infer<typeof CapturedTaskSchema>;

/** Parse an untrusted value (e.g. a task file) as a CapturedTask; throws ZodError. */
export function parseCapturedTask(input: unknown): CapturedTask {
  return CapturedTaskSchema.parse(input);
}
