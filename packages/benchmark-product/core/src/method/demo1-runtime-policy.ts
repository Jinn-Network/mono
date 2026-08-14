/**
 * Demo-1 v2 runtime selection.
 *
 * The accepted v1 rehearsal and E2 artifacts keep their historical Haiku/high pins. This separate
 * local method artifact chooses the cheapest informative Claude configuration before a v2 freeze.
 * It cannot execute provider work, alter a task pool, or reinterpret a completed assessment.
 */

import { createHash } from "node:crypto";
import {
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";

export const DEMO1_RUNTIME_POLICY_SCHEMA = "jinn.demo1.runtime-policy.v2" as const;
export const DEMO1_RUNTIME_SELECTION_SCHEMA = "jinn.demo1.runtime-selection.v2" as const;

export const DEMO1_RUNTIME_CANDIDATES = [
  { model: "claude-haiku-4-5-20251001", effort: "low", modelClass: "haiku" },
  { model: "claude-haiku-4-5-20251001", effort: "medium", modelClass: "haiku" },
  { model: "claude-haiku-4-5-20251001", effort: "high", modelClass: "haiku" },
  { model: "claude-sonnet-5", effort: "low", modelClass: "sonnet" },
] as const;

export const DEMO1_PROVIDER_CALL_LIMITS = {
  providerPathSmoke: 6,
  suitabilityPerCandidate: 12,
  qualificationBeforeHumanReview: 48,
  e2Rehearsal: 200,
  official: 600,
} as const;

export type Demo1RuntimeCandidate = typeof DEMO1_RUNTIME_CANDIDATES[number];

export interface Demo1RuntimeSuitabilitySummary {
  readonly expectedCells: 12;
  readonly accountedCells: number;
  readonly validGraderOutcomes: number;
  readonly passes: number;
  readonly timeoutFails: number;
  readonly unresolvedInfrastructure: number;
  readonly incompatibilities: number;
  readonly skillLoaderCanary: "pass" | "fail" | "not-run";
}

export type Demo1RuntimeDisposition =
  | "select-runtime"
  | "escalate-runtime"
  | "change-task-band"
  | "stop-inconclusive";

export interface Demo1RuntimePolicyDecision {
  readonly schema: typeof DEMO1_RUNTIME_POLICY_SCHEMA;
  readonly candidateIndex: number;
  readonly candidate: Demo1RuntimeCandidate;
  readonly summary: Demo1RuntimeSuitabilitySummary;
  readonly disposition: Demo1RuntimeDisposition;
  readonly nextCandidate: Demo1RuntimeCandidate | null;
  readonly reasons: readonly string[];
  readonly limits: typeof DEMO1_PROVIDER_CALL_LIMITS;
}

export interface Demo1RuntimeSelection {
  readonly schema: typeof DEMO1_RUNTIME_SELECTION_SCHEMA;
  readonly policyDecisionSha256: string;
  readonly selected: Demo1RuntimeCandidate;
  readonly harness: {
    readonly id: "claude-code";
    readonly version: string;
    readonly executableSha256: string;
  };
  readonly skillSha256: string;
  readonly taskPoolSha256: string;
  readonly limits: typeof DEMO1_PROVIDER_CALL_LIMITS;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

function canonicalBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function integer(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${field} must be an integer from 0 to ${maximum}`);
  }
  return value;
}

function normalizeSummary(summary: Demo1RuntimeSuitabilitySummary): Demo1RuntimeSuitabilitySummary {
  if (summary.expectedCells !== 12) throw new TypeError("runtime suitability requires exactly 12 cells");
  if (!["pass", "fail", "not-run"].includes(summary.skillLoaderCanary)) {
    throw new TypeError("skill loader canary status is invalid");
  }
  const normalized: Demo1RuntimeSuitabilitySummary = {
    expectedCells: 12,
    accountedCells: integer(summary.accountedCells, "accountedCells", 12),
    validGraderOutcomes: integer(summary.validGraderOutcomes, "validGraderOutcomes", 12),
    passes: integer(summary.passes, "passes", 12),
    timeoutFails: integer(summary.timeoutFails, "timeoutFails", 12),
    unresolvedInfrastructure: integer(summary.unresolvedInfrastructure, "unresolvedInfrastructure", 12),
    incompatibilities: integer(summary.incompatibilities, "incompatibilities", 12),
    skillLoaderCanary: summary.skillLoaderCanary,
  };
  if (normalized.validGraderOutcomes > normalized.accountedCells
    || normalized.passes > normalized.validGraderOutcomes
    || normalized.timeoutFails + normalized.validGraderOutcomes > normalized.accountedCells
    || normalized.unresolvedInfrastructure + normalized.timeoutFails
      + normalized.validGraderOutcomes > normalized.accountedCells
    || normalized.incompatibilities + normalized.unresolvedInfrastructure
      + normalized.timeoutFails + normalized.validGraderOutcomes > normalized.accountedCells) {
    throw new TypeError("runtime suitability counts are internally inconsistent");
  }
  return normalized;
}

/**
 * Applies the preregistered cheapest-capable rule. Only a measured floor effect may move to a
 * stronger model. A ceiling changes the task band; infrastructure and loader failures stop.
 */
export function decideDemo1Runtime(
  candidateIndex: number,
  input: Demo1RuntimeSuitabilitySummary,
): Demo1RuntimePolicyDecision {
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0
    || candidateIndex >= DEMO1_RUNTIME_CANDIDATES.length) {
    throw new TypeError("candidateIndex is outside the frozen runtime ladder");
  }
  const candidate = DEMO1_RUNTIME_CANDIDATES[candidateIndex]!;
  const summary = normalizeSummary(input);
  const reasons: string[] = [];
  let disposition: Demo1RuntimeDisposition;

  if (summary.skillLoaderCanary !== "pass") {
    disposition = "stop-inconclusive";
    reasons.push(summary.skillLoaderCanary === "fail"
      ? "skill-loader-canary-failed"
      : "skill-loader-canary-not-run");
  } else if (summary.incompatibilities > 0) {
    disposition = "stop-inconclusive";
    reasons.push("model-authentication-or-launcher-incompatibility");
  } else if (summary.accountedCells !== 12
    || summary.validGraderOutcomes < 10
    || summary.unresolvedInfrastructure > 0
    || summary.timeoutFails > 2) {
    disposition = "stop-inconclusive";
    if (summary.accountedCells !== 12) reasons.push("not-all-12-cells-accounted");
    if (summary.validGraderOutcomes < 10) reasons.push("fewer-than-10-valid-grader-outcomes");
    if (summary.unresolvedInfrastructure > 0) reasons.push("unresolved-infrastructure");
    if (summary.timeoutFails > 2) reasons.push("more-than-2-timeout-fails");
  } else if (summary.passes > 10) {
    disposition = "change-task-band";
    reasons.push("ceiling-effect-task-band-too-easy");
  } else if (summary.passes < 2) {
    if (candidateIndex + 1 < DEMO1_RUNTIME_CANDIDATES.length) {
      disposition = "escalate-runtime";
      reasons.push("floor-effect-cheapest-runtime-uninformative");
    } else {
      disposition = "stop-inconclusive";
      reasons.push("floor-effect-runtime-ladder-exhausted");
    }
  } else {
    disposition = "select-runtime";
    reasons.push("cheapest-capable-runtime-selected");
  }

  return {
    schema: DEMO1_RUNTIME_POLICY_SCHEMA,
    candidateIndex,
    candidate,
    summary,
    disposition,
    nextCandidate: disposition === "escalate-runtime"
      ? DEMO1_RUNTIME_CANDIDATES[candidateIndex + 1]!
      : null,
    reasons,
    limits: DEMO1_PROVIDER_CALL_LIMITS,
  };
}

export function demo1RuntimePolicyDecisionDigest(decision: Demo1RuntimePolicyDecision): string {
  const rebuilt = decideDemo1Runtime(decision.candidateIndex, decision.summary);
  if (!Buffer.from(canonicalBytes(rebuilt)).equals(Buffer.from(canonicalBytes(decision)))) {
    throw new TypeError("runtime policy decision does not recompute from canonical inputs");
  }
  return digest(decision);
}

export function buildDemo1RuntimeSelection(input: {
  readonly decision: Demo1RuntimePolicyDecision;
  readonly harnessVersion: string;
  readonly executableSha256: string;
  readonly skillSha256: string;
  readonly taskPoolSha256: string;
}): Demo1RuntimeSelection {
  if (input.decision.disposition !== "select-runtime") {
    throw new TypeError("only a selected cheapest-capable runtime may be frozen");
  }
  if (!VERSION.test(input.harnessVersion)) throw new TypeError("harnessVersion must be exact semver");
  for (const [field, value] of [
    ["executableSha256", input.executableSha256],
    ["skillSha256", input.skillSha256],
    ["taskPoolSha256", input.taskPoolSha256],
  ] as const) {
    if (!SHA256.test(value)) throw new TypeError(`${field} must be 64 lowercase hex`);
  }
  return {
    schema: DEMO1_RUNTIME_SELECTION_SCHEMA,
    policyDecisionSha256: demo1RuntimePolicyDecisionDigest(input.decision),
    selected: input.decision.candidate,
    harness: {
      id: "claude-code",
      version: input.harnessVersion,
      executableSha256: input.executableSha256,
    },
    skillSha256: input.skillSha256,
    taskPoolSha256: input.taskPoolSha256,
    limits: DEMO1_PROVIDER_CALL_LIMITS,
  };
}

export function verifyDemo1RuntimeSelection(
  selection: Demo1RuntimeSelection,
  decision: Demo1RuntimePolicyDecision,
): void {
  const rebuilt = buildDemo1RuntimeSelection({
    decision,
    harnessVersion: selection.harness.version,
    executableSha256: selection.harness.executableSha256,
    skillSha256: selection.skillSha256,
    taskPoolSha256: selection.taskPoolSha256,
  });
  if (!Buffer.from(canonicalBytes(rebuilt)).equals(Buffer.from(canonicalBytes(selection)))) {
    throw new TypeError("runtime selection does not recompute from canonical inputs");
  }
}
