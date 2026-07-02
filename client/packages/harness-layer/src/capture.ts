/**
 * Harness-layer capture path — the privacy surface (spec §5).
 *
 * `capture(task, opts)` runs a captured task through the mandatory scrub
 * pipeline and returns a `PendingEnvelope`: the captured-but-not-yet-consented
 * state. Per the 2026-07-02 schema review, consent flags on `TraceEnvelopeV0`
 * are literal `true`, so the pre-consent state cannot BE a `TraceEnvelopeV0` —
 * the pending wrapper converts to one only at consent (preview renders the
 * would-be envelope; the Task 4 publish path performs the real conversion).
 *
 * Fail-closed: any scrub-stage failure throws `CaptureScrubError` — no
 * envelope, no partial output, never a silent pass.
 *
 * Scrub pipeline: reuses the seller-side pipeline from
 * `client/src/trajectory/scrub/build.ts` (key-policy → openredaction →
 * secretlint → optional ML PII) via `scrubCaptureSpans()`, then appends two
 * capture-local stages that close gaps the base pipeline demonstrably has on
 * the seeded-secrets fixture: a plain email-shape stage (openredaction's
 * EMAIL pattern misses e.g. `jane.doe@example-corp.com`) and a home-path
 * stage (`/Users/<name>/…`, `/home/<name>/…` → `/users/anon/…`; the base
 * pipeline never touches paths).
 *
 * Fitting rule (docs/envelope-v0.md): the conversion MUST produce envelopes
 * inside the frozen caps. Over-long sessions are head/tail-sampled to
 * `MAX_STEPS` (never dropped); oversized step attributes are truncated with
 * the cut keys listed in the step's `truncatedKeys` receipt (never silent —
 * both surface in the `ScrubReport`).
 *
 * Plan: docs/superpowers/plans/2026-07-02-jinn-harness-network-v0-plan.md
 * Task 3 (issue #1310).
 */

import { z } from 'zod';
import { buildScrubPipeline, DEFAULT_KEY_POLICY } from '../../../src/trajectory/scrub/build.js';
import { ScrubPipeline } from '../../../src/trajectory/scrub/pipeline.js';
import { scrubCaptureSpans } from '../../../src/trajectory/scrub/emit-scrub.js';
import { classifyKey, type KeyPolicy } from '../../../src/trajectory/scrub/key-policy.js';
import type { PiiDetector } from '../../../src/trajectory/scrub/ml-pii-stage.js';
import type {
  Attributes,
  RedactionRecord,
  ScrubResult,
  ScrubStage,
} from '../../../src/trajectory/scrub/types.js';
import {
  MAX_STEPS,
  MAX_STEP_ATTRIBUTES_BYTES,
  OutcomeStatusSchema,
  parseTraceEnvelopeV0,
  TRACE_ENVELOPE_SCHEMA_VERSION,
  VerifiabilityTierSchema,
  type TraceEnvelopeV0,
} from './envelope.js';

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

/**
 * One entry in the redaction diff. `before` is the original (sensitive)
 * value: it exists so the operator can audit locally what was removed, and
 * it must NEVER be persisted or published — display-only.
 */
export interface ScrubRedaction {
  /** Where in the envelope, e.g. `steps[2].attributes["llm.prompt"]`. */
  field: string;
  /** Scrub-pipeline stage (`key-policy`, `openredaction`, `secretlint`, …) or `fit`. */
  stage: string;
  /** Rule / entity detail when the stage reports one (e.g. `AWS_ACCESS_KEY`). */
  detail?: string;
  /** Original value — local display only, never persisted. */
  before?: unknown;
  /** Published value; `undefined` when the field was dropped entirely. */
  after: unknown;
}

export const PENDING_ENVELOPE_KIND = 'jinn.pending-envelope.v0' as const;

/**
 * The captured-but-not-yet-consented state. Not a `TraceEnvelopeV0` (the
 * envelope's consent flags are literal `true`, so an unconsented envelope is
 * not constructible); it becomes one only at consent — `preview()` renders
 * the would-be envelope, the Task 4 publish path performs the conversion for
 * real. Only `capture()` constructs this type; `redactions[].before` values
 * live in memory for the local preview and must never be written anywhere.
 */
export interface PendingEnvelope {
  kind: typeof PENDING_ENVELOPE_KIND;
  /** Every TraceEnvelopeV0 field except `consent`, scrubbed and fitted. */
  draft: Omit<TraceEnvelopeV0, 'consent'>;
  /** The redaction diff for the local preview. NEVER persisted. */
  redactions: ScrubRedaction[];
}

export interface CaptureOptions {
  /** Key policy for the base pipeline. Default: DEFAULT_KEY_POLICY. */
  policy?: KeyPolicy;
  /** When provided, the base pipeline gains the ML PII (GLiNER) stage. */
  piiDetector?: PiiDetector;
  /** Injectable base pipeline (tests). Overrides policy/piiDetector. */
  pipeline?: ScrubPipeline;
}

/** A scrub-stage failure. capture() is fail-closed: no envelope was produced. */
export class CaptureScrubError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`scrub failed — capture aborted, no envelope produced (fail-closed): ${detail}`);
    this.name = 'CaptureScrubError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Capture-local scrub stages
// ---------------------------------------------------------------------------

const CAPTURE_STAGE_VERSION = '0.1.0';

/** Plain email shape. Deliberately broad — over-redacting an email is cheap. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

/** POSIX home-dir path segment carrying a username. */
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s"'`]+/g;

/**
 * Builds a regex-replacement stage over `content`-classified string values,
 * mirroring the shape of the base-pipeline stages.
 */
function replacementStage(
  name: string,
  policy: KeyPolicy,
  pattern: RegExp,
  replacement: string,
  detail: string,
): ScrubStage {
  return {
    name,
    version: CAPTURE_STAGE_VERSION,
    scrub(attributes: Attributes): ScrubResult {
      const out: Attributes = {};
      const redactions: RedactionRecord[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') {
          out[key] = value;
          continue;
        }
        let hits = 0;
        const scrubbed = value.replace(pattern, () => {
          hits += 1;
          return replacement;
        });
        out[key] = scrubbed;
        for (let i = 0; i < hits; i += 1) {
          redactions.push({ key, stage: name, kind: 'pii', detail });
        }
      }
      return { attributes: out, redactions };
    },
  };
}

/**
 * ScrubPipeline that chains the base pipeline with the capture-local stages
 * and records each run's input + result, in order. `scrubCaptureSpans()`
 * runs the pipeline exactly once per span, in span order, so run index i
 * corresponds to step i — that correspondence is what lets the redaction
 * diff carry `before` values without re-implementing the span walk.
 */
class RecordingScrubPipeline extends ScrubPipeline {
  readonly runs: Array<{ before: Attributes; result: ScrubResult }> = [];

  constructor(private readonly chain: ScrubPipeline[]) {
    super([]);
  }

  override get components(): Array<{ name: string; version: string }> {
    return this.chain.flatMap((p) => p.components);
  }

  override async run(attributes: Attributes): Promise<ScrubResult> {
    let current = attributes;
    const redactions: RedactionRecord[] = [];
    for (const pipeline of this.chain) {
      const result = await pipeline.run(current);
      current = result.attributes;
      redactions.push(...result.redactions);
    }
    const result: ScrubResult = { attributes: current, redactions };
    this.runs.push({ before: attributes, result });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Fitting (docs/envelope-v0.md, "Fitting rule")
// ---------------------------------------------------------------------------

const TRUNCATION_SUFFIX = '…[truncated]';

function serialisedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Truncate a step's scrubbed attributes until they fit
 * `MAX_STEP_ATTRIBUTES_BYTES`, cutting the largest value first. Returns the
 * fitted attributes plus the cut keys — the visible truncation receipt.
 */
function fitAttributes(attributes: Attributes): {
  attributes: Attributes;
  truncatedKeys: string[];
  cuts: Array<{ key: string; before: unknown; after: string }>;
} {
  const out: Attributes = { ...attributes };
  const cutsByKey = new Map<string, { key: string; before: unknown; after: string }>();
  // JSON escaping can make the serialised form of a cut string larger than
  // the raw byte count suggests, so a single pass may land slightly over —
  // the loop re-cuts (the same key if it is still the largest) until the
  // step fits. Each iteration strictly shrinks the chosen value, so the only
  // non-terminating shape is thousands of already-empty values: guard it.
  let guard = Object.keys(out).length * 4 + 8;

  while (serialisedBytes(out) > MAX_STEP_ATTRIBUTES_BYTES) {
    guard -= 1;
    const largest = Object.entries(out)
      .sort((a, b) => serialisedBytes(b[1]) - serialisedBytes(a[1]))[0];
    if (!largest || guard <= 0) {
      throw new CaptureScrubError(new Error(
        `step attributes cannot be fitted under ${MAX_STEP_ATTRIBUTES_BYTES} bytes`,
      ));
    }
    const [key, value] = largest;
    const overshoot = serialisedBytes(out) - MAX_STEP_ATTRIBUTES_BYTES;
    const serialised = typeof value === 'string' ? value : JSON.stringify(value);
    // Cut by bytes with a safety margin for JSON escaping + the suffix.
    const keepBytes = Math.max(
      0,
      Buffer.byteLength(serialised, 'utf8') - overshoot - TRUNCATION_SUFFIX.length - 16,
    );
    const after = Buffer.from(serialised, 'utf8')
      .subarray(0, keepBytes)
      .toString('utf8')
      // A byte cut can split a multi-byte character; drop the replacement char.
      .replace(/�+$/, '') + TRUNCATION_SUFFIX;
    out[key] = after;
    const existing = cutsByKey.get(key);
    if (existing) {
      existing.after = after; // re-cut: keep the ORIGINAL value as `before`
    } else {
      cutsByKey.set(key, { key, before: attributes[key], after });
    }
  }

  const cuts = [...cutsByKey.values()];
  return { attributes: out, truncatedKeys: cuts.map((c) => c.key), cuts };
}

/**
 * Head/tail-sample an over-long step list down to `MAX_STEPS` (keep the
 * first half and the last half; the middle is sampled out). Never drops the
 * session — that is the fitting rule's explicit prohibition.
 */
function sampleSteps<T>(steps: T[]): { steps: T[]; sampledOut: number } {
  if (steps.length <= MAX_STEPS) return { steps, sampledOut: 0 };
  const head = Math.ceil(MAX_STEPS / 2);
  const tail = MAX_STEPS - head;
  return {
    steps: [...steps.slice(0, head), ...steps.slice(steps.length - tail)],
    sampledOut: steps.length - MAX_STEPS,
  };
}

// ---------------------------------------------------------------------------
// capture()
// ---------------------------------------------------------------------------

function fieldRef(stepIndex: number, key: string): string {
  return `steps[${stepIndex}].attributes[${JSON.stringify(key)}]`;
}

/**
 * Run the captured task through the scrub pipeline and the fitting rule and
 * return the pending (pre-consent) envelope plus its redaction diff.
 * Fail-closed: throws `CaptureScrubError` on any scrub-stage failure.
 */
export async function capture(
  task: CapturedTask,
  opts: CaptureOptions = {},
): Promise<PendingEnvelope> {
  const policy = opts.policy ?? DEFAULT_KEY_POLICY;
  const base = opts.pipeline ?? buildScrubPipeline({
    policy,
    ...(opts.piiDetector ? { piiDetector: opts.piiDetector } : {}),
  });
  const captureLocal = new ScrubPipeline([
    replacementStage('capture-email', policy, EMAIL_PATTERN, '[EMAIL]', 'email'),
    replacementStage('capture-home-path', policy, HOME_PATH_PATTERN, '/users/anon', 'home-path'),
  ]);
  const recorder = new RecordingScrubPipeline([base, captureLocal]);

  let scrubbedSteps;
  let summaryRun: ScrubResult;
  const summaryBag: Attributes = {
    'task.summary': task.task.summary,
    ...(task.outcome.summary !== undefined ? { 'outcome.summary': task.outcome.summary } : {}),
  };
  try {
    scrubbedSteps = await scrubCaptureSpans(task.steps, recorder);
    // The envelope calls `task.summary` a "scrubbed one-line descriptor" —
    // capture is where that becomes true. Same pipeline, pseudo-attribute bag.
    summaryRun = await recorder.run(summaryBag);
  } catch (err) {
    throw new CaptureScrubError(err);
  }

  // Pair each scrubbed step with its pipeline run (one run per span, in
  // order), then head/tail-sample. Redactions are reported only for retained
  // steps: sampled-out steps never publish, so their diff is moot.
  const paired = scrubbedSteps.map((step, i) => ({ step, run: recorder.runs[i]! }));
  const { steps: retained, sampledOut } = sampleSteps(paired);

  const redactions: ScrubRedaction[] = [];
  if (sampledOut > 0) {
    redactions.push({
      field: 'steps',
      stage: 'fit',
      detail: `head/tail-sampled: ${sampledOut} middle step(s) removed to fit ${MAX_STEPS}`,
      after: `${MAX_STEPS} steps`,
    });
  }

  const draftSteps = retained.map(({ step, run }, index) => {
    const fitted = fitAttributes(run.result.attributes);
    for (const record of run.result.redactions) {
      redactions.push({
        field: fieldRef(index, record.key),
        stage: record.stage,
        ...(record.detail ? { detail: record.detail } : {}),
        before: run.before[record.key],
        after: fitted.attributes[record.key],
      });
    }
    for (const cut of fitted.cuts) {
      redactions.push({
        field: fieldRef(index, cut.key),
        stage: 'fit',
        detail: `truncated to fit ${MAX_STEP_ATTRIBUTES_BYTES} bytes`,
        before: cut.before,
        after: cut.after,
      });
    }
    return {
      spanId: step.spanId,
      parentSpanId: step.parentSpanId,
      name: step.name,
      startTimeUnixNano: step.startTimeUnixNano,
      endTimeUnixNano: step.endTimeUnixNano,
      attributes: fitted.attributes,
      redactedKeys: step.redactedKeys,
      ...(fitted.truncatedKeys.length > 0 ? { truncatedKeys: fitted.truncatedKeys } : {}),
    };
  });

  for (const record of summaryRun.redactions) {
    redactions.push({
      field: record.key,
      stage: record.stage,
      ...(record.detail ? { detail: record.detail } : {}),
      before: summaryBag[record.key],
      after: summaryRun.attributes[record.key],
    });
  }
  // Summaries are content keys the policy never drops; assert the invariant
  // rather than publish an envelope with a silently-missing summary.
  const scrubbedTaskSummary = summaryRun.attributes['task.summary'];
  if (typeof scrubbedTaskSummary !== 'string') {
    throw new CaptureScrubError(new Error('scrub removed task.summary entirely'));
  }
  const scrubbedOutcomeSummary = summaryRun.attributes['outcome.summary'];
  if (task.outcome.summary !== undefined && typeof scrubbedOutcomeSummary !== 'string') {
    throw new CaptureScrubError(new Error('scrub removed outcome.summary entirely'));
  }

  const draft: PendingEnvelope['draft'] = {
    schemaVersion: TRACE_ENVELOPE_SCHEMA_VERSION,
    session: task.session,
    task: { ...task.task, summary: scrubbedTaskSummary.trim() },
    environment: task.environment,
    steps: draftSteps,
    outcome: {
      ...task.outcome,
      ...(typeof scrubbedOutcomeSummary === 'string' ? { summary: scrubbedOutcomeSummary.trim() } : {}),
    },
    cost: task.cost,
    provenance: task.provenance,
  };

  // Fail-closed schema check: the would-be envelope must already be valid at
  // capture time (fitting worked, caps hold, strings are inside their caps).
  // Throwing here beats surfacing a broken envelope at preview/publish.
  parseTraceEnvelopeV0({
    ...draft,
    consent: { contributionConsent: true, scrubCompleted: true },
  });

  return { kind: PENDING_ENVELOPE_KIND, draft, redactions };
}
