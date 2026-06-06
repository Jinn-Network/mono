/**
 * jinn.trajectory.v1 — OTLP-JSON-shaped trace blob signed and uploaded once
 * per run. Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 trajectory row + K6 span profile, §4.3 trajectory profile deliverable.
 *
 * Each span carries jinn.prevSpanHash (in-run hash chain) + jinn.span.kind
 * (normative profile). Secret-scrub (§4.3 V1 minimum) produces a run-level
 * redactionManifest signed alongside the spans.
 */

import { z } from 'zod/v3';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const JinnSpanKindSchema = z.enum([
  'jinn.phase',
  'jinn.llm_call',
  'jinn.mcp_call',
  'jinn.artifact.emit',
  'jinn.venue_io',
  'jinn.state_transition',
]);
export type JinnSpanKind = z.infer<typeof JinnSpanKindSchema>;

const EventSchema = z.object({
  timeUnixNano: z.string(),
  name: z.string(),
  attributes: z.record(z.unknown()).optional(),
});

const SpanStatusSchema = z.object({
  code: z.enum(['UNSET', 'OK', 'ERROR']),
  message: z.string().optional(),
});

/** An OTLP-shaped span with Jinn-required attributes. */
export const SpanSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  parentSpanId: z.string().regex(/^[0-9a-f]{16}$/).nullable(),
  name: z.string().min(1),
  kind: z.enum(['INTERNAL', 'CLIENT', 'SERVER', 'PRODUCER', 'CONSUMER']),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes: z
    .record(z.unknown())
    .refine((a) => typeof a['jinn.span.kind'] === 'string', {
      message: 'jinn.span.kind attribute required',
    })
    .refine((a) => typeof a['jinn.prevSpanHash'] === 'string', {
      message: 'jinn.prevSpanHash attribute required',
    }),
  events: z.array(EventSchema),
  status: SpanStatusSchema,
});
export type Span = z.infer<typeof SpanSchema>;

export const RedactionManifestSchema = z
  .object({
    spans: z.array(
      z.object({
        spanId: z.string().regex(/^[0-9a-f]{16}$/),
        redactedKeys: z.array(z.string()),
      }),
    ),
    totalRedactions: z.number().int().nonnegative(),
  })
  .refine(
    (m) => m.spans.reduce((acc, s) => acc + s.redactedKeys.length, 0) === m.totalRedactions,
    { message: 'totalRedactions must equal sum of per-span redactedKeys' },
  );
export type RedactionManifest = z.infer<typeof RedactionManifestSchema>;

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

export const JinnTrajectoryV1Schema = z.object({
  schemaVersion: z.literal('jinn.trajectory.v1'),
  runId: z.string().min(1),
  parentEnvelopeCid: z.string().nullable(),
  spans: z.array(SpanSchema),
  redactionManifest: RedactionManifestSchema,
  signature: SignatureSchema,
});
export type JinnTrajectoryV1 = z.infer<typeof JinnTrajectoryV1Schema>;

/** Unsigned form — what we hash + sign. */
export const UnsignedTrajectorySchema = JinnTrajectoryV1Schema.omit({ signature: true });
export type UnsignedTrajectory = z.infer<typeof UnsignedTrajectorySchema>;

/**
 * Per-run capture manifest — records the operator's authorisation and
 * coarse harness-bundle metadata for telemetry capture. v0 deliberately
 * keeps operator control at the bundle level (no per-file curation) per
 * DR-2026-05-07-g; the audit surface is "what did the operator authorise
 * the daemon to read?" not "what did the daemon ultimately read?"
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §3.3
 */
export const CaptureManifestSchema = z.object({
  scrubProcessors: z.array(z.object({
    name: z.string(),
    version: z.string(),
    config: z.record(z.unknown()).optional(),
  })),
  reviewedBy: z.object({
    safeAddress: z.string(),
    reviewedAt: z.string().datetime(),
  }),
  trustedRepoToggle: z.boolean(),
  harnessBundle: z.object({
    included: z.boolean(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    allowedDirectoriesHash: z.string().regex(/^[0-9a-f]{64}$/),
    capturePath: z.enum(['A', 'B', 'C', 'D']),
  }),
});

export type CaptureManifest = z.infer<typeof CaptureManifestSchema>;

/** sha256 of an empty (no-files) bundle. Used when the operator opts out of harness-bundle capture. */
export const EMPTY_BUNDLE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
