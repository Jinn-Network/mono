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
 * plain-patterns → secretlint → optional ML PII) via `scrubCaptureSpans()`.
 * The email/home-path gap-closers this file originally carried graduated
 * into the shared plain-patterns stage (#1330), so the daemon publish path
 * and this capture path share one implementation.
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
  parseTraceEnvelopeV0,
  TRACE_ENVELOPE_SCHEMA_VERSION,
  type TraceEnvelopeV0,
} from './envelope.js';

// The captured-task schema + parser moved into @jinn-network/core in C2
// (#1833). Re-export them so every downstream `./capture.js` importer of
// these symbols keeps working unchanged. The scrub half of this file stays
// here (C5's move).
export { CapturedTaskSchema, parseCapturedTask, type CapturedTask } from '@jinn-network/core';
// A re-export does not create a local binding, and capture() below references
// CapturedTask and parseCapturedTask below — import them locally too.
import { parseCapturedTask, type CapturedTask } from '@jinn-network/core';

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
  /** Canonical Episode-only facts that the frozen trace draft cannot carry. */
  episodeFacts: {
    session: Pick<CapturedTask['session'], 'kind' | 'parentSessionId'>;
    task: Pick<
      CapturedTask['task'],
      'repositorySlug' | 'baseCommit' | 'createdAt' | 'instanceId'
    >;
    environment: Pick<
      CapturedTask['environment'],
      'skillsLoadout' | 'generatorModel' | 'distributionClass' | 'verifier'
    >;
    trajectoryKinds: Array<CapturedTask['steps'][number]['kind']>;
    attemptGroup?: CapturedTask['attemptGroup'];
  };
  /** The redaction diff for the local preview. NEVER persisted. */
  redactions: ScrubRedaction[];
}

export interface CaptureOptions {
  /** Key policy for the base pipeline. Default: DEFAULT_KEY_POLICY. */
  policy?: KeyPolicy;
  /** When provided, the base pipeline gains the ML PII (GLiNER) stage. */
  piiDetector?: PiiDetector;
  /**
   * Injectable base pipeline. Production consumer: seed import passes
   * buildSeedScrubPipeline() (#1409); also used by tests. Overrides
   * policy/piiDetector.
   */
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

function episodeFactBag(task: CapturedTask): Attributes {
  return {
    ...(task.session.kind !== undefined
      ? { 'episodeFacts.session.kind': task.session.kind }
      : {}),
    ...(task.session.parentSessionId !== undefined
      ? { 'episodeFacts.session.parentSessionId': task.session.parentSessionId }
      : {}),
    ...(task.task.repositorySlug !== undefined
      ? { 'episodeFacts.task.repositorySlug': task.task.repositorySlug }
      : {}),
    ...(task.task.baseCommit !== undefined
      ? { 'episodeFacts.task.baseCommit': task.task.baseCommit }
      : {}),
    ...(task.task.createdAt !== undefined
      ? { 'episodeFacts.task.createdAt': task.task.createdAt }
      : {}),
    ...(task.task.instanceId !== undefined
      ? { 'episodeFacts.task.instanceId': task.task.instanceId }
      : {}),
    ...(task.environment.skillsLoadout !== undefined
      ? { 'episodeFacts.environment.skillsLoadout': task.environment.skillsLoadout }
      : {}),
    ...(task.environment.generatorModel !== undefined
      ? {
        'episodeFacts.environment.generatorModel.id': task.environment.generatorModel.id,
        ...(task.environment.generatorModel.provider !== undefined
          ? {
            'episodeFacts.environment.generatorModel.provider':
              task.environment.generatorModel.provider,
          }
          : {}),
        ...(task.environment.generatorModel.openWeights !== undefined
          ? {
            'episodeFacts.environment.generatorModel.openWeights':
              task.environment.generatorModel.openWeights,
          }
          : {}),
        'episodeFacts.environment.generatorModel.source':
          task.environment.generatorModel.source,
      }
      : {}),
    ...(task.environment.distributionClass !== undefined
      ? {
        'episodeFacts.environment.distributionClass':
          task.environment.distributionClass,
      }
      : {}),
    ...(task.environment.verifier !== undefined
      ? {
        'episodeFacts.environment.verifier.type': task.environment.verifier.type,
        'episodeFacts.environment.verifier.failToPass':
          task.environment.verifier.failToPass,
        'episodeFacts.environment.verifier.passToPass':
          task.environment.verifier.passToPass,
        ...(task.environment.verifier.evalSemanticsVersion !== undefined
          ? {
            'episodeFacts.environment.verifier.evalSemanticsVersion':
              task.environment.verifier.evalSemanticsVersion,
          }
          : {}),
      }
      : {}),
    'episodeFacts.trajectoryKinds': task.steps.map((step) => step.kind),
    ...(task.attemptGroup !== undefined
      ? {
        'episodeFacts.attemptGroup.groupId': task.attemptGroup.groupId,
        'episodeFacts.attemptGroup.attemptId': task.attemptGroup.attemptId,
        'episodeFacts.attemptGroup.relatedAttemptRefs':
          task.attemptGroup.relatedAttemptRefs,
        ...(task.attemptGroup.groupSize !== undefined
          ? { 'episodeFacts.attemptGroup.groupSize': task.attemptGroup.groupSize }
          : {}),
        ...(task.attemptGroup.nPass !== undefined
          ? { 'episodeFacts.attemptGroup.nPass': task.attemptGroup.nPass }
          : {}),
        ...(task.attemptGroup.nFail !== undefined
          ? { 'episodeFacts.attemptGroup.nFail': task.attemptGroup.nFail }
          : {}),
      }
      : {}),
  };
}

/**
 * Rebuild a CapturedTask using only scrubbed Episode-only values. Parsing the
 * result keeps this boundary fail-closed if a scrub stage changes a structural
 * enum/type or removes a required member of a present nested block.
 */
function taskWithScrubbedEpisodeFacts(
  task: CapturedTask,
  attributes: Attributes,
): CapturedTask {
  const fact = (key: string): unknown => attributes[`episodeFacts.${key}`];
  const kinds = fact('trajectoryKinds');
  return parseCapturedTask({
    ...task,
    session: {
      sessionId: task.session.sessionId,
      capturedAt: task.session.capturedAt,
      ...(fact('session.kind') !== undefined ? { kind: fact('session.kind') } : {}),
      ...(fact('session.parentSessionId') !== undefined
        ? { parentSessionId: fact('session.parentSessionId') }
        : {}),
    },
    task: {
      summary: task.task.summary,
      distributionTags: task.task.distributionTags,
      ...(fact('task.repositorySlug') !== undefined
        ? { repositorySlug: fact('task.repositorySlug') }
        : {}),
      ...(fact('task.baseCommit') !== undefined
        ? { baseCommit: fact('task.baseCommit') }
        : {}),
      ...(fact('task.createdAt') !== undefined
        ? { createdAt: fact('task.createdAt') }
        : {}),
      ...(fact('task.instanceId') !== undefined
        ? { instanceId: fact('task.instanceId') }
        : {}),
    },
    environment: {
      harness: task.environment.harness,
      model: task.environment.model,
      tools: task.environment.tools,
      ...(fact('environment.skillsLoadout') !== undefined
        ? { skillsLoadout: fact('environment.skillsLoadout') }
        : {}),
      ...(task.environment.generatorModel !== undefined
        ? {
          generatorModel: {
            id: fact('environment.generatorModel.id'),
            ...(fact('environment.generatorModel.provider') !== undefined
              ? { provider: fact('environment.generatorModel.provider') }
              : {}),
            ...(fact('environment.generatorModel.openWeights') !== undefined
              ? { openWeights: fact('environment.generatorModel.openWeights') }
              : {}),
            source: fact('environment.generatorModel.source'),
          },
        }
        : {}),
      ...(fact('environment.distributionClass') !== undefined
        ? { distributionClass: fact('environment.distributionClass') }
        : {}),
      ...(task.environment.verifier !== undefined
        ? {
          verifier: {
            type: fact('environment.verifier.type'),
            failToPass: fact('environment.verifier.failToPass'),
            passToPass: fact('environment.verifier.passToPass'),
            ...(fact('environment.verifier.evalSemanticsVersion') !== undefined
              ? {
                evalSemanticsVersion:
                  fact('environment.verifier.evalSemanticsVersion'),
              }
              : {}),
          },
        }
        : {}),
    },
    steps: task.steps.map((step, index) => ({
      ...step,
      ...(Array.isArray(kinds) && kinds[index] !== undefined
        ? { kind: kinds[index] }
        : { kind: undefined }),
    })),
    ...(task.attemptGroup !== undefined
      ? {
        attemptGroup: {
          groupId: fact('attemptGroup.groupId'),
          attemptId: fact('attemptGroup.attemptId'),
          relatedAttemptRefs: fact('attemptGroup.relatedAttemptRefs'),
          ...(fact('attemptGroup.groupSize') !== undefined
            ? { groupSize: fact('attemptGroup.groupSize') }
            : {}),
          ...(fact('attemptGroup.nPass') !== undefined
            ? { nPass: fact('attemptGroup.nPass') }
            : {}),
          ...(fact('attemptGroup.nFail') !== undefined
            ? { nFail: fact('attemptGroup.nFail') }
            : {}),
        },
      }
      : {}),
  });
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
  // The email/home-path gap-closers graduated into the shared pipeline
  // (plain-patterns stage, #1330) — the base pipeline alone now covers the
  // seeded-secrets fixture. Injected test pipelines take the same path.
  const recorder = new RecordingScrubPipeline([base]);

  let scrubbedSteps;
  let summaryRun: ScrubResult;
  let factRun: ScrubResult;
  let scrubbedFactTask: CapturedTask;
  const summaryBag: Attributes = {
    'task.summary': task.task.summary,
    ...(task.outcome.summary !== undefined ? { 'outcome.summary': task.outcome.summary } : {}),
  };
  const factBag = episodeFactBag(task);
  try {
    scrubbedSteps = await scrubCaptureSpans(task.steps, recorder);
    // The envelope calls `task.summary` a "scrubbed one-line descriptor" —
    // capture is where that becomes true. Same pipeline, pseudo-attribute bag.
    summaryRun = await recorder.run(summaryBag);
    factRun = await recorder.run(factBag);
    scrubbedFactTask = taskWithScrubbedEpisodeFacts(task, factRun.attributes);
  } catch (err) {
    throw new CaptureScrubError(err);
  }

  // Pair each scrubbed step with its pipeline run (one run per span, in
  // order), then head/tail-sample. Redactions are reported only for retained
  // steps: sampled-out steps never publish, so their diff is moot.
  const paired = scrubbedSteps.map((step, i) => ({
    step,
    run: recorder.runs[i]!,
    kind: scrubbedFactTask.steps[i]!.kind,
  }));
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
  for (const record of factRun.redactions) {
    redactions.push({
      field: record.key,
      stage: record.stage,
      ...(record.detail ? { detail: record.detail } : {}),
      before: factBag[record.key],
      after: factRun.attributes[record.key],
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
    session: {
      sessionId: task.session.sessionId,
      capturedAt: task.session.capturedAt,
    },
    task: {
      summary: scrubbedTaskSummary.trim(),
      distributionTags: task.task.distributionTags,
    },
    environment: {
      harness: task.environment.harness,
      model: task.environment.model,
      tools: task.environment.tools,
    },
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

  return {
    kind: PENDING_ENVELOPE_KIND,
    draft,
    episodeFacts: {
      session: {
        ...(scrubbedFactTask.session.kind
          ? { kind: scrubbedFactTask.session.kind }
          : {}),
        ...(scrubbedFactTask.session.parentSessionId
          ? { parentSessionId: scrubbedFactTask.session.parentSessionId }
          : {}),
      },
      task: {
        ...(scrubbedFactTask.task.repositorySlug
          ? { repositorySlug: scrubbedFactTask.task.repositorySlug }
          : {}),
        ...(scrubbedFactTask.task.baseCommit
          ? { baseCommit: scrubbedFactTask.task.baseCommit }
          : {}),
        ...(scrubbedFactTask.task.createdAt !== undefined
          ? { createdAt: scrubbedFactTask.task.createdAt }
          : {}),
        ...(scrubbedFactTask.task.instanceId
          ? { instanceId: scrubbedFactTask.task.instanceId }
          : {}),
      },
      environment: {
        ...(scrubbedFactTask.environment.skillsLoadout
          ? { skillsLoadout: scrubbedFactTask.environment.skillsLoadout }
          : {}),
        ...(scrubbedFactTask.environment.generatorModel
          ? { generatorModel: scrubbedFactTask.environment.generatorModel }
          : {}),
        ...(scrubbedFactTask.environment.distributionClass
          ? { distributionClass: scrubbedFactTask.environment.distributionClass }
          : {}),
        ...(scrubbedFactTask.environment.verifier
          ? { verifier: scrubbedFactTask.environment.verifier }
          : {}),
      },
      trajectoryKinds: retained.map(({ kind }) => kind),
      ...(scrubbedFactTask.attemptGroup
        ? { attemptGroup: scrubbedFactTask.attemptGroup }
        : {}),
    },
    redactions,
  };
}
