// SPDX-License-Identifier: Apache-2.0

/**
 * The native evaluator host's staged evaluation inputs — everything the host puts in the
 * Attempt's `input/` directory that the evaluation Task does not name itself.
 *
 * WHY THIS EXISTS. The evaluator adapters are parse-only by ratified design ruling
 * (`docs/superpowers/plans/2026-07-30-evaluator-adapters.md` Finding 1: "adapters are parse-only
 * and resolve already-produced grader output from the subject Results, falling back to
 * host-provisioned `evaluation-context.json`; when it is absent they raise
 * `EvaluationOperationalError` ... rather than inventing a verdict"). The EVALUATOR LOOP is the
 * named execution owner of that host-provisioned context
 * (`docs/superpowers/plans/2026-07-30-cutover-stage-2-evaluator-flow.md` Task 11: "**This stage is
 * the execution owner** ... the adapter's resolution order is fixed by that plan and this task must
 * satisfy it in the workspace it lays down: ... `evaluation-context.json` in `input/` (written by
 * this task's provisioner)"). That obligation was never carried onto the native path — the Task 11
 * provisioner exists only as `docs/salvage/stage-2/grader-execution.ts.txt` — so the native
 * provisioner staged the subject graph and the EvaluationSpec and nothing else, and the shipped
 * prediction deployment (`operator/deployments/evaluator/prediction-market-deployment.mjs`, which
 * wires `contextResolutionSnapshotSource()`) refused every live grade with "the evaluation context
 * carries no resolutionSnapshot". This module is that missing obligation, discharged.
 *
 * WHERE THE PREDICTION CONTEXT COMES FROM. Only from material the evaluator already holds and has
 * already verified: the subject Task, whose digest the derived evaluation Task pins
 * (`payload.subjectTask.digest`) and whose bytes the provisioner materializes under that digest.
 * `market.marketId`, `window`, and `consensusProbabilityYes` are a pure re-projection of that
 * Task's own `payload.forecast` — the identical projection the benchmark venue performs
 * (`packages/benchmark-product/core/src/venue/resolution.ts`'s `deriveSampleResolution`), so the
 * file's shape is one convention, not a native dialect.
 *
 * WHY THE SNAPSHOT IS ALWAYS `unresolved`. The market's OUTCOME is the one field no verified
 * material carries. The subject Task declares the market, the window and the consensus; it does
 * not declare what happened. The benchmark venue INVENTS an outcome for its bundled sample
 * ("consensus >= 0.5 resolves YES") and its own module header says that stand-in "must never be
 * mistaken for a real resolution source". A production evaluator must not invent one: fabricating
 * ground truth is exactly the "never invent a verdict" rule the parse-only ruling protects. So the
 * native host states the honest fact — the resolution is not known here — as
 * `status: "unresolved"`, which is a first-class outcome of this profile rather than an error:
 * the golden EvaluationSpec declares `unscorable: [{ name: "market-unresolved", disposition:
 * "recorded-inconclusive" }]`, the adapter maps it to an `inconclusive` verdict, and `inconclusive`
 * settles on-chain as the DECISION-GRADE `VerdictCode.Unresolved(4)`
 * (`operator/src/daemon/native-verdict-observation.ts`'s `statementVerdictFor`). The loop closes with
 * a real, signed, sealed verdict.
 *
 * Supplying a real resolution is a supply-side product decision (the requester would have to post
 * one, or an oracle would have to be admitted as verified material). Until that exists, every
 * native prediction verdict is honestly `Unresolved`.
 */

import { createHash } from "node:crypto";
import {
  parserAllowlistKey,
  type DeterministicProcessBlock,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import { PREDICTION_PARSER } from "@jinn-network/task-execution-evaluator-adapters";

/** The name the evaluation harness reads the host-provisioned context from. */
export const EVALUATION_CONTEXT_INPUT_NAME = "evaluation-context.json";

const JSON_MEDIA_TYPE = "application/json";

/** A refusal to build a required staged input. Never a silent `{}`. */
export class NativeEvaluationContextError extends Error {
  override readonly name = "NativeEvaluationContextError";
}

/** One host-staged `input/` file: exact bytes plus the descriptor the provisioner materializes. */
export interface StagedHostInput {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

/**
 * The evaluation context the prediction adapter reads. Field-for-field the shape
 * `contextResolutionSnapshotSource()` requires and the benchmark venue already writes.
 */
export interface PredictionEvaluationContext {
  readonly resolutionSnapshot: {
    readonly status: "unresolved";
    readonly marketId: string;
    readonly conditionId: string;
  };
  readonly market: { readonly marketId: string; readonly conditionId: string };
  readonly window: { readonly startTs: number; readonly endTs: number };
  readonly consensusProbabilityYes: string;
}

const PROBABILITY = /^(0(\.\d+)?|1(\.0+)?)$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function digestOf(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when the EvaluationSpec's declared parser is the prediction-market parser — the exact
 * `parserAllowlistKey` identity `createPredictionEvaluatorRegistration`'s own
 * `specificationCompatibility` matches on, so the host stages a context for precisely the
 * specifications the prediction adapter will be selected to serve.
 */
export function specificationRequiresPredictionContext(specification: EvaluationSpec): boolean {
  if (specification.family !== "deterministic-process") return false;
  const block = specification.familyBlock as DeterministicProcessBlock | undefined;
  if (block?.parser === undefined) return false;
  return parserAllowlistKey(block.parser) === parserAllowlistKey(PREDICTION_PARSER);
}

/**
 * A condition id for a subject Task that declares none. The `prediction-forecast/1.0` payload
 * carries `marketId` but no `conditionId`, while the adapter's `market.identity` check compares the
 * snapshot's condition id against the declared one. Both sides come from this one derivation, so
 * the check stays self-consistent and no value is invented out of thin air: it is a pure function
 * of the verified `marketId`. The venue's sample derivation uses the same construction under a
 * `sample-` prefix; this prefix says plainly that the evaluator derived it.
 */
function derivedConditionId(marketId: string): string {
  return `jinn-derived-condition-${createHash("sha256").update(marketId, "utf8").digest("hex").slice(0, 16)}`;
}

function refuse(detail: string): never {
  throw new NativeEvaluationContextError(
    `cannot derive the prediction evaluation context from the subject Task: ${detail}`,
  );
}

/**
 * Derives the prediction evaluation context from the verified subject Task bytes. Fail-closed:
 * a subject Task that does not carry a well-formed `prediction-forecast` payload is refused with
 * the precise field at fault, never degraded into an empty context.
 */
export function derivePredictionEvaluationContext(
  subjectTaskBytes: Uint8Array,
): PredictionEvaluationContext {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(subjectTaskBytes));
  } catch {
    refuse("the subject Task is not valid UTF-8 JSON");
  }
  if (!isObject(document)) refuse("the subject Task is not a JSON object");
  const payload = document["payload"];
  if (!isObject(payload)) refuse("the subject Task carries no payload object");
  const forecast = payload["forecast"];
  if (!isObject(forecast)) refuse("the subject Task payload carries no forecast object");

  const marketId = forecast["marketId"];
  if (typeof marketId !== "string" || marketId.length === 0) {
    refuse("payload.forecast.marketId is not a non-empty string");
  }
  const consensusProbabilityYes = forecast["consensusProbabilityYes"];
  if (typeof consensusProbabilityYes !== "string" || !PROBABILITY.test(consensusProbabilityYes)) {
    refuse("payload.forecast.consensusProbabilityYes is not a probability string");
  }
  const observedAt = forecast["observedAt"];
  if (typeof observedAt !== "string" || !UTC.test(observedAt) || Number.isNaN(Date.parse(observedAt))) {
    refuse("payload.forecast.observedAt is not a UTC RFC3339 timestamp");
  }
  const resolvesAt = forecast["resolvesAt"];
  if (typeof resolvesAt !== "string" || !UTC.test(resolvesAt) || Number.isNaN(Date.parse(resolvesAt))) {
    refuse("payload.forecast.resolvesAt is not a UTC RFC3339 timestamp");
  }
  const startTs = Date.parse(observedAt);
  const endTs = Date.parse(resolvesAt);
  if (endTs <= startTs) {
    refuse("payload.forecast.resolvesAt is not strictly after payload.forecast.observedAt");
  }

  const conditionId = derivedConditionId(marketId);
  return {
    resolutionSnapshot: { status: "unresolved", marketId, conditionId },
    market: { marketId, conditionId },
    window: { startTs, endTs },
    consensusProbabilityYes,
  };
}

/** The exact bytes staged as `input/evaluation-context.json`. */
export function predictionEvaluationContextBytes(subjectTaskBytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(derivePredictionEvaluationContext(subjectTaskBytes)),
  );
}

/**
 * Every `input/` file the native evaluator HOST contributes, in materialization order. The
 * evaluation Task names its own subject graph; these are the two the host owes on top of it — the
 * EvaluationSpec the Task binds by digest but does not carry as an input, and (for a
 * prediction-parsed specification) the evaluation context the adapter reads.
 *
 * This is the single definition of that set. Anything that provisions a native evaluation
 * workspace — the daemon's provisioner and its tests alike — stages exactly what this returns, so
 * a test workspace can never disagree with the one a live operator gets.
 */
export function nativeEvaluationHostInputs(input: {
  readonly specification: EvaluationSpec;
  readonly specificationBytes: Uint8Array;
  /**
   * Resolved ONLY when the specification actually requires a context. A container-graded
   * specification, whose adapter reads nothing from the context, must not be made to depend on a
   * subject Task the host would otherwise never touch.
   */
  readonly subjectTaskBytes: () => Uint8Array;
  readonly specificationMediaType: string;
}): readonly StagedHostInput[] {
  const staged: StagedHostInput[] = [{
    name: "evaluation-spec.json",
    mediaType: input.specificationMediaType,
    bytes: input.specificationBytes,
    digest: digestOf(input.specificationBytes),
  }];
  if (specificationRequiresPredictionContext(input.specification)) {
    const bytes = predictionEvaluationContextBytes(input.subjectTaskBytes());
    staged.push({
      name: EVALUATION_CONTEXT_INPUT_NAME,
      mediaType: JSON_MEDIA_TYPE,
      bytes,
      digest: digestOf(bytes),
    });
  }
  return staged;
}
