/**
 * Captured-task schema — the raw, pre-scrub input to the harness capture path.
 *
 * Extracted from `client/packages/harness-layer/src/capture.ts` in C2 (#1833):
 * the parse half of capture.ts has no scrub / `client/src` dependency (only
 * zod + the two envelope enums), so it moved into `@jinn-network/core`.
 * C5 subsequently moved the scrub implementation alongside it while leaving
 * capture orchestration in the layer.
 */
import { z } from 'zod';
import { OutcomeStatusSchema, VerifiabilityTierSchema } from './envelope.js';

/** Unix-nanosecond timestamp string (OTel span convention). */
const UnixNanoSchema = z.string().regex(/^\d+$/, 'unix-nanosecond digit string');

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
  }),
  task: z.strictObject({
    summary: z.string().min(1),
    distributionTags: z.array(z.string().min(1)).min(1),
  }),
  environment: z.strictObject({
    harness: z.strictObject({
      name: z.string().min(1),
      version: z.string().min(1),
    }),
    model: z.string().min(1),
    tools: z.array(z.string().min(1)),
  }),
  steps: z.array(z.strictObject({
    spanId: z.string().min(1),
    parentSpanId: z.string().min(1).nullable(),
    name: z.string().min(1),
    startTimeUnixNano: UnixNanoSchema,
    endTimeUnixNano: UnixNanoSchema,
    attributes: z.record(z.string(), z.unknown()),
    /** Keys already redacted at ingest, if the capture recorded any. */
    redactedKeys: z.array(z.string().min(1)).default([]),
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
  provenance: z.enum(['contributed', 'imported']).default('contributed'),
});
export type CapturedTask = z.infer<typeof CapturedTaskSchema>;

/** Parse an untrusted value (e.g. a task file) as a CapturedTask; throws ZodError. */
export function parseCapturedTask(input: unknown): CapturedTask {
  return CapturedTaskSchema.parse(input);
}
