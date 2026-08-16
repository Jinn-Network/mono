/**
 * Layer-1 trace envelope — `jinn.trace-envelope.v0`.
 *
 * The scrubbed evidence envelope a harness publishes to the corpus when a
 * user completes (or fails) a task with contribution consent on. FROZEN at
 * v0 operator sign-off (spec Q1) — changes after that are a spec amendment
 * to `spec/2026-07-02-jinn-harness-network.md`.
 *
 * The schema is CLOSED (strict objects at every level): unknown fields are
 * rejected so nothing can be smuggled into published traces, or silently
 * depended on by consumers, without a spec amendment.
 *
 * Field-by-field rationale, reader map, and three validated examples:
 * `packages/layer/docs/envelope-v0.md` (the examples in that
 * doc are parsed against this schema in `test/envelope.test.ts`).
 *
 * Step shape mirrors the capture-span shape (`SpanRow`,
 * `operator/src/store/captures.ts`) minus session/trace IDs, which are hoisted
 * to `session`.
 *
 * Plan: docs/superpowers/plans/2026-07-02-jinn-harness-network-v0-plan.md
 * Task 2 (issue #1309).
 */

import { z } from 'zod';

export const TRACE_ENVELOPE_SCHEMA_VERSION = 'jinn.trace-envelope.v0' as const;

export const EVIDENCE_PROVENANCES = [
  'contributed',
  'imported',
  'derived-from-history',
] as const;
export const EvidenceProvenanceSchema = z.enum(EVIDENCE_PROVENANCES);
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;

/** Max steps per envelope — keeps envelopes anchorable and cheap to fetch. */
export const MAX_STEPS = 512;

/** Max serialised size of a single step's `attributes`, in bytes. */
export const MAX_STEP_ATTRIBUTES_BYTES = 16 * 1024;

/** Max freeform distribution tags per envelope. */
export const MAX_DISTRIBUTION_TAGS = 16;

/**
 * Verifiability tiers, weakest → strongest (spec §5). The
 * ContributionActivityChecker counts contributions against this ladder;
 * layer-2 promotion reads it as the quality gate.
 */
export const VERIFIABILITY_TIERS = [
  'user-accepted',
  'tests-passed',
  'evaluator-verified',
] as const;

export const VerifiabilityTierSchema = z.enum(VERIFIABILITY_TIERS);
export type VerifiabilityTier = z.infer<typeof VerifiabilityTierSchema>;

export const OutcomeStatusSchema = z.enum(['completed', 'failed', 'abandoned']);
export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>;

/** Unix-nanosecond timestamp string (OTel span convention). */
const UnixNanoSchema = z.string().regex(/^\d+$/, 'unix-nanosecond digit string');

/** Non-empty, no surrounding whitespace. */
const TrimmedString = (max: number) =>
  z.string().min(1).max(max).regex(/^\S(.*\S)?$/s, 'no surrounding whitespace');

/**
 * One compressed trace step. Mirrors `SpanRow`
 * (operator/src/store/captures.ts): scrubbed `attributes` plus the
 * `redactedKeys` receipt of what the scrub pipeline removed.
 */
export const TraceStepSchema = z.strictObject({
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).nullable(),
  name: z.string().min(1),
  startTimeUnixNano: UnixNanoSchema,
  endTimeUnixNano: UnixNanoSchema,
  attributes: z.record(z.string(), z.unknown()).superRefine((attrs, ctx) => {
    let serialised: string;
    try {
      serialised = JSON.stringify(attrs);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'attributes must be JSON-serialisable' });
      return;
    }
    const bytes = Buffer.byteLength(serialised, 'utf8');
    if (bytes > MAX_STEP_ATTRIBUTES_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `attributes serialise to ${bytes} bytes (max ${MAX_STEP_ATTRIBUTES_BYTES})`,
      });
    }
  }),
  redactedKeys: z.array(z.string().min(1)),
  /**
   * Which attribute keys the capture→envelope pipeline truncated to fit
   * `MAX_STEP_ATTRIBUTES_BYTES` — the visible truncation receipt, sibling
   * to `redactedKeys` (2026-07-02 schema review, Q4).
   */
  truncatedKeys: z.array(z.string().min(1)).optional(),
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const TraceEnvelopeV0Schema = z.strictObject({
  /** Migration gate — v1 readers reject/route on this. */
  schemaVersion: z.literal(TRACE_ENVELOPE_SCHEMA_VERSION),

  /** Capture-session identity: ledger correlation + dedup. */
  session: z.strictObject({
    sessionId: z.string().min(1).max(128),
    capturedAt: z.iso.datetime(),
  }),

  /** What the user was doing — the demand signal (spec §5). */
  task: z.strictObject({
    /** Scrubbed one-line descriptor of the task. */
    summary: TrimmedString(500),
    /**
     * Freeform — no fixed taxonomy; clustering is inferred server-side.
     * At least one tag: an untagged envelope is invisible to the signal.
     */
    distributionTags: z.array(TrimmedString(64)).min(1).max(MAX_DISTRIBUTION_TAGS),
  }),

  /** Config-diversity fingerprint (spec §5): harness, model, tools. */
  environment: z.strictObject({
    harness: z.strictObject({
      name: z.string().min(1),
      version: z.string().min(1),
    }),
    model: z.string().min(1),
    /** Tool names only — never tool configs or arguments. */
    tools: z.array(z.string().min(1).max(128)).max(64),
  }),

  /** The compressed trace body — the evidence itself. */
  steps: z.array(TraceStepSchema).min(1).max(MAX_STEPS),

  /** What happened, and how the status was established. */
  outcome: z.strictObject({
    status: OutcomeStatusSchema,
    /**
     * How the recorded status was established — the anti-farming line the
     * activity checker counts against. Qualifies the status, so failed
     * tasks carry a tier too.
     */
    verifiabilityTier: VerifiabilityTierSchema,
    summary: TrimmedString(500).optional(),
  }),

  /** What the task cost to run — the §8 capability-gate metric. */
  cost: z.strictObject({
    durationMs: z.number().int().nonnegative(),
    tokens: z.strictObject({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }).optional(),
    /** Decimal string — money is never IEEE-754. An estimate, named as such. */
    usdEstimate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  }),

  /**
   * The publish gate (spec §5), fail-closed at the type level: both flags
   * are literal `true`, so an envelope representing an unconsented or
   * unscrubbed trace is not constructible.
   */
  consent: z.strictObject({
    /** First-run consent given AND no per-task veto on this trace. */
    contributionConsent: z.literal(true),
    /** The mandatory scrub pipeline completed on this trace. */
    scrubCompleted: z.literal(true),
  }),

  /**
   * `contributed` = real user trace; `imported` = seed (spec §7);
   * `derived-from-history` = a same-schema projection of immutable ledger
   * history. The distribution signal excludes `imported`.
   */
  provenance: EvidenceProvenanceSchema,
});
export type TraceEnvelopeV0 = z.infer<typeof TraceEnvelopeV0Schema>;

/** Parse an untrusted value as a TraceEnvelopeV0; throws ZodError on any deviation. */
export function parseTraceEnvelopeV0(input: unknown): TraceEnvelopeV0 {
  return TraceEnvelopeV0Schema.parse(input);
}
