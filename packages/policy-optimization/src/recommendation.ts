// SPDX-License-Identifier: MIT

import {
  BENCHMARKING_METHOD_IDS,
  documentDigest,
  parseMatrix,
  parseReport,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { canonicalJsonText } from "@jinn-network/policy-identity";
import { refuse } from "./errors.js";
import type { CampaignObjective, ObjectiveMethodRef } from "./types.js";

export const SAME_OPERATOR_EVALUATION_LIMITATION =
  "independence: disclosed — solver and evaluator roles use separate identities and keys, but the same operator, host, OS user, and administrative domain control both" as const;

export type RecommendationReasonCode =
  | "promotion-incomplete"
  | "preregistration-failed"
  | "fidelity-gate-failed"
  | "constraint-gate-failed"
  | "missing-method-report"
  | "improvements-not-greater-than-regressions"
  | "mcnemar-not-significant"
  | "insufficient-provenance-groups"
  | "provenance-sign-not-significant"
  | "noninferiority-iut-not-passed";

export interface RecommendationDecision {
  /** Local, recomputable projection — never a sealed authority record. */
  readonly projection: "RecommendationDecision";
  readonly status: "proven" | "inconclusive";
  readonly recommendedTupleDigest: string;
  readonly currentTupleDigest: string;
  readonly challengerTupleDigest: string;
  readonly reasonCodes: readonly RecommendationReasonCode[];
  readonly basis: {
    readonly runDigest: string;
    readonly matrixDigest: string;
    readonly reportDigests: readonly string[];
    readonly methodRefs: readonly ObjectiveMethodRef[];
  };
  readonly limitations: readonly [typeof SAME_OPERATOR_EVALUATION_LIMITATION];
}

export interface ProjectRecommendationInput {
  readonly objectivePreset: "more-tasks-succeed@1" | "same-success-lower-cost@1";
  readonly objective: CampaignObjective;
  readonly currentTupleDigest: string;
  readonly challengerTupleDigest: string;
  readonly runBytes: Uint8Array;
  readonly matrixBytes: Uint8Array;
  readonly reportBytes: readonly Uint8Array[];
}

function sameMethod(left: { id: string; version: string; parameters: unknown }, right: ObjectiveMethodRef): boolean {
  return left.id === right.id && left.version === right.version
    && canonicalJsonText(left.parameters) === canonicalJsonText(right.parameters);
}

function resultObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const perSubject = (value as Record<string, unknown>)["perSubject"];
  if (!Array.isArray(perSubject) || perSubject.length !== 1) return undefined;
  const entry = perSubject[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const results = (entry as Record<string, unknown>)["results"];
  return typeof results === "object" && results !== null && !Array.isArray(results)
    ? results as Record<string, unknown>
    : undefined;
}

function belowFivePercent(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value)) return false;
  const [integer, fraction = ""] = value.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${integer}${fraction}`);
  return numerator * 100n < 5n * denominator;
}

function reportFor(
  reports: readonly ReturnType<typeof parseReport>[],
  method: ObjectiveMethodRef,
): ReturnType<typeof parseReport> | undefined {
  const matching = reports.filter((report) => sameMethod(report.method, method));
  if (matching.length > 1) {
    refuse("invalid-document", "reports", `multiple Reports claim ${method.id}@${method.version} with the same parameters`);
  }
  return matching[0];
}

/** Recomputable recommendation over exact Run, Matrix, Report and MethodRef bytes. */
export function projectRecommendation(input: ProjectRecommendationInput): RecommendationDecision {
  const run = parseRun(input.runBytes);
  const matrix = parseMatrix(input.matrixBytes);
  const reports = input.reportBytes.map((bytes) => parseReport(bytes));
  const runDigest = documentDigest(input.runBytes);
  const matrixDigest = documentDigest(input.matrixBytes);
  const matrixRun = `sha256:${matrix.run.digest.sha256}`;
  if (matrixRun !== runDigest) {
    refuse("invalid-document", "matrix.run", `Matrix names ${matrixRun}, exact Run bytes digest to ${runDigest}`);
  }
  for (const report of reports) {
    if (report.subjects.length !== 1 || `sha256:${report.subjects[0]!.digest.sha256}` !== matrixDigest) {
      refuse("invalid-document", "report.subjects", "every recommendation Report must name the exact promotion Matrix");
    }
  }

  const reasons: RecommendationReasonCode[] = [];
  if (matrix.completeness.runOutcome !== "complete") reasons.push("promotion-incomplete");
  const fidelityPassed = matrix.cells.every((cell) =>
    cell.verification.harness === "match"
    && cell.verification.model === "match"
    && cell.verification.loadout === "match"
    && cell.verification.isolation === "match"
    && cell.verification.checksFailed.length === 0
  );
  if (!fidelityPassed) reasons.push("fidelity-gate-failed");

  const planned = run.analysisPlan ?? [];
  for (const method of input.objective.methods) {
    const report = reportFor(reports, method);
    if (report === undefined) {
      reasons.push("missing-method-report");
      continue;
    }
    if (report.preregistered !== true || !planned.some((entry) => sameMethod({
      id: entry.method, version: entry.version, parameters: entry.parameters,
    }, method))) {
      reasons.push("preregistration-failed");
    }
  }

  for (const constraint of input.objective.constraints) {
    const report = reportFor(reports, constraint.method);
    const results = report === undefined ? undefined : resultObject(report.results);
    const verdict = results?.["verdict"];
    if (report === undefined || (verdict !== "PASS" && verdict !== "pass" && results?.["passed"] !== true)) {
      reasons.push("constraint-gate-failed");
    }
  }

  if (input.objectivePreset === "more-tasks-succeed@1") {
    const mcnemarRef = input.objective.methods.find((method) => method.id === BENCHMARKING_METHOD_IDS.pairedMcnemar);
    const signRef = input.objective.methods.find((method) => method.id === BENCHMARKING_METHOD_IDS.provenanceClusterSign);
    const mcnemar = mcnemarRef === undefined ? undefined : reportFor(reports, mcnemarRef);
    const sign = signRef === undefined ? undefined : reportFor(reports, signRef);
    const mcnemarResults = mcnemar === undefined ? undefined : resultObject(mcnemar.results);
    const signResults = sign === undefined ? undefined : resultObject(sign.results);
    const improved = mcnemarResults?.["improved"];
    const regressed = mcnemarResults?.["regressed"];
    if (typeof improved !== "number" || typeof regressed !== "number" || improved <= regressed) {
      reasons.push("improvements-not-greater-than-regressions");
    }
    if (!belowFivePercent(mcnemarResults?.["pValue"])) reasons.push("mcnemar-not-significant");
    if (typeof signResults?.["nonTied"] !== "number" || signResults["nonTied"] < 6) {
      reasons.push("insufficient-provenance-groups");
    }
    if (!belowFivePercent(signResults?.["pValue"])) reasons.push("provenance-sign-not-significant");
  } else {
    const method = input.objective.methods.find((entry) => entry.id === BENCHMARKING_METHOD_IDS.noninferiorityIut);
    const report = method === undefined ? undefined : reportFor(reports, method);
    if (report === undefined || resultObject(report.results)?.["verdict"] !== "PASS") {
      reasons.push("noninferiority-iut-not-passed");
    }
  }

  const reasonCodes = [...new Set(reasons)];
  const proven = reasonCodes.length === 0;
  return {
    projection: "RecommendationDecision",
    status: proven ? "proven" : "inconclusive",
    recommendedTupleDigest: proven ? input.challengerTupleDigest : input.currentTupleDigest,
    currentTupleDigest: input.currentTupleDigest,
    challengerTupleDigest: input.challengerTupleDigest,
    reasonCodes,
    basis: {
      runDigest,
      matrixDigest,
      reportDigests: input.reportBytes.map(documentDigest).sort(),
      methodRefs: input.objective.methods.map((method) => ({
        id: method.id, version: method.version, parameters: { ...method.parameters },
      })),
    },
    limitations: [SAME_OPERATOR_EVALUATION_LIMITATION],
  };
}
