// SPDX-License-Identifier: Apache-2.0

import {
  documentDigest,
  parseBenchmarkAnalysisManifest,
  parseEvidenceCohort,
  HUMAN_LABEL_RESOLUTION_MEDIA_TYPE,
  parseHumanLabelResolutionPayload,
  type HumanLabelResolution,
  type EvidenceCohortMember,
  type EvidenceRecordReference,
} from "@jinn-network/benchmarking-protocol";
import {
  recordDigest,
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
  type ExecutionEvidenceDocument,
  type ResultEvaluationEvidence,
} from "@jinn-network/evidence-protocol";
import { parseExactDsseEnvelope } from "@jinn-network/trust-core";

import type {
  CohortDiagnostic,
  ExactRecordResolver,
  VerifiedCohortMember,
  VerifiedExecution,
  VerifyEvidenceCohortInput,
  EvidenceCohortVerification,
} from "./types.js";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function referenceKey(reference: EvidenceRecordReference): string {
  return `${reference.family}\u0000${reference.record.digest.sha256}`;
}

function diagnostic(
  code: CohortDiagnostic["code"],
  path: string,
  message: string,
): CohortDiagnostic {
  return { code, path, message };
}

function references(entity: Record<string, unknown>, property: string): string[] {
  const raw = entity[property];
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return values.flatMap((value) =>
    typeof value === "object" && value !== null &&
    typeof (value as { "@id"?: unknown })["@id"] === "string"
      ? [(value as { "@id": string })["@id"]]
      : [],
  );
}

function types(entity: Record<string, unknown>): string[] {
  const value = entity["@type"];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string" ? [value] : [];
}

function projectExecution(
  document: ExecutionEvidenceDocument,
  bytes: Uint8Array,
): VerifiedExecution | undefined {
  const byId = new Map(document["@graph"].map((entity) => [entity["@id"], entity]));
  const root = byId.get("./");
  if (root === undefined) return undefined;
  const executionId = references(root, "mentions")[0];
  const execution = executionId === undefined ? undefined : byId.get(executionId);
  if (execution === undefined) return undefined;
  const task = references(execution, "object")
    .map((id) => byId.get(id))
    .find((entity) => entity !== undefined && types(entity).includes("prov:Plan"));
  if (task === undefined || typeof task.sha256 !== "string") return undefined;
  const results = references(execution, "result").map((id) => byId.get(id));
  if (results.some((entity) => entity === undefined || typeof entity.sha256 !== "string")) {
    return undefined;
  }
  return {
    document,
    bytes,
    executionId,
    taskDigest: `sha256:${task.sha256}`,
    resultDigests: results
      .map((entity) => `sha256:${entity!.sha256 as string}` as const)
      .sort(compare),
  };
}

function resolveExact(
  resolver: ExactRecordResolver,
  reference: EvidenceRecordReference,
  path: string,
  diagnostics: CohortDiagnostic[],
): Uint8Array | undefined {
  let bytes: Uint8Array;
  try {
    bytes = resolver.resolve(reference);
  } catch (error) {
    diagnostics.push(diagnostic(
      "RECORD_UNAVAILABLE",
      path,
      error instanceof Error ? error.message : "record is unavailable",
    ));
    return undefined;
  }
  const actual = recordDigest(bytes).slice(7);
  if (actual !== reference.record.digest.sha256) {
    diagnostics.push(diagnostic(
      "RECORD_DIGEST_MISMATCH",
      path,
      `expected sha256:${reference.record.digest.sha256}, got sha256:${actual}`,
    ));
    return undefined;
  }
  return bytes;
}

function descriptorDigest(
  reference: { readonly record: { readonly digest: { readonly sha256: string } } },
): `sha256:${string}` {
  return `sha256:${reference.record.digest.sha256}`;
}

function evaluationSubjects(
  evidence: ResultEvaluationEvidence,
): { task?: `sha256:${string}`; results: `sha256:${string}`[] } {
  const byName = new Map(evidence.statement.subject.map((subject) => [subject.name, subject]));
  const task = byName.get(evidence.statement.predicate.taskSubject);
  return {
    ...(task === undefined ? {} : { task: `sha256:${task.digest.sha256}` as const }),
    results: evidence.statement.predicate.resultSubjects
      .flatMap((name) => {
        const subject = byName.get(name);
        return subject === undefined ? [] : [`sha256:${subject.digest.sha256}` as const];
      })
      .sort(compare),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function humanOpinion(evaluation: ResultEvaluationEvidence): "ACCEPT" | "REJECT" | "inconclusive" | undefined {
  const value = evaluation.statement.predicate.measurements?.find(({ name }) => name === "humanLabel")?.value;
  return value === "ACCEPT" || value === "REJECT" || value === "inconclusive" ? value : undefined;
}

function resolutionMatchesOpinions(
  resolution: HumanLabelResolution,
  opinions: readonly ("ACCEPT" | "REJECT" | "inconclusive")[],
): boolean {
  if (resolution.resolution.status === "admitted") {
    const admittedLabel = resolution.resolution.label;
    return opinions.length > 0 && opinions.every((opinion) => opinion === admittedLabel);
  }
  if (resolution.resolution.reason === "inconclusive") return opinions.includes("inconclusive");
  if (resolution.resolution.reason === "disagreement") {
    return opinions.includes("ACCEPT") && opinions.includes("REJECT");
  }
  return opinions.length < resolution.policy.requiredReviewers;
}

function verifyMember(
  member: EvidenceCohortMember,
  index: number,
  input: VerifyEvidenceCohortInput,
  diagnostics: CohortDiagnostic[],
): VerifiedCohortMember | undefined {
  const base = `/members/${index}`;
  const executionBytes = resolveExact(input.records, member.execution, `${base}/execution`, diagnostics);
  if (executionBytes === undefined) return undefined;
  const executionReport = validateExecutionEvidence(executionBytes);
  if (!executionReport.conforms || executionReport.value === undefined) {
    diagnostics.push(diagnostic(
      "RECORD_NONCONFORMING",
      `${base}/execution`,
      executionReport.diagnostics.map((entry) => `${entry.code}:${entry.path}`).join(", "),
    ));
    return undefined;
  }
  const execution = projectExecution(executionReport.value, executionBytes);
  if (
    execution === undefined ||
    execution.taskDigest !== member.taskDigest ||
    !sameStrings(execution.resultDigests, member.resultDigests)
  ) {
    diagnostics.push(diagnostic(
      "EXECUTION_SUBJECT_MISMATCH",
      `${base}/execution`,
      "Execution Evidence Task and Results do not match the cohort member",
    ));
    return undefined;
  }

  const evaluations = new Map<string, ResultEvaluationEvidence>();
  for (const [claimIndex, reference] of member.evaluations.considered.entries()) {
    const path = `${base}/evaluations/considered/${claimIndex}`;
    const bytes = resolveExact(input.records, reference, path, diagnostics);
    if (bytes === undefined) continue;
    const report = validateResultEvaluation(bytes);
    if (!report.conforms || report.value === undefined) {
      diagnostics.push(diagnostic("RECORD_NONCONFORMING", path,
        report.diagnostics.map((entry) => `${entry.code}:${entry.path}`).join(", ")));
      continue;
    }
    const subjects = evaluationSubjects(report.value);
    if (subjects.task !== member.taskDigest || !sameStrings(subjects.results, member.resultDigests)) {
      diagnostics.push(diagnostic(
        "EVALUATION_SUBJECT_MISMATCH",
        path,
        "Result Evaluation does not bind the member's exact Task and Result set",
      ));
      continue;
    }
    evaluations.set(referenceKey(reference), report.value);
  }

  const verifications = new Map<string, ReturnType<typeof validateExecutionVerification>["value"]>();
  for (const [claimIndex, reference] of member.verifications.considered.entries()) {
    const path = `${base}/verifications/considered/${claimIndex}`;
    const bytes = resolveExact(input.records, reference, path, diagnostics);
    if (bytes === undefined) continue;
    const report = validateExecutionVerification(bytes);
    if (!report.conforms || report.value === undefined) {
      diagnostics.push(diagnostic("RECORD_NONCONFORMING", path,
        report.diagnostics.map((entry) => `${entry.code}:${entry.path}`).join(", ")));
      continue;
    }
    const subject = report.value.statement.subject[0];
    if (
      subject === undefined ||
      `sha256:${subject.digest.sha256}` !== descriptorDigest(member.execution) ||
      report.value.statement.predicate.executionId !== execution.executionId
    ) {
      diagnostics.push(diagnostic(
        "VERIFICATION_SUBJECT_MISMATCH",
        path,
        "Execution Verification does not bind this execution record and execution id",
      ));
      continue;
    }
    verifications.set(referenceKey(reference), report.value);
  }

  const labelResolutions = new Map<string, HumanLabelResolution>();
  for (const [claimIndex, reference] of member.labelResolutions.considered.entries()) {
    const path = `${base}/labelResolutions/considered/${claimIndex}`;
    const bytes = resolveExact(input.records, reference, path, diagnostics);
    if (bytes === undefined) continue;
    let resolution: HumanLabelResolution;
    try {
      const envelope = parseExactDsseEnvelope(bytes);
      if (envelope.payloadType !== HUMAN_LABEL_RESOLUTION_MEDIA_TYPE) {
        throw new TypeError("wrong HumanLabelResolution payload type");
      }
      resolution = parseHumanLabelResolutionPayload(envelope.payloadBytes);
    } catch (error) {
      const validator = input.additionalValidators?.find(({ family }) => family === reference.family);
      if (validator !== undefined) {
        diagnostics.push(...validator.validate(bytes).map((entry) => ({
          ...entry,
          path: `${path}${entry.path}`,
        })));
        continue;
      }
      diagnostics.push(diagnostic(
        "LABEL_RESOLUTION_INVALID",
        path,
        error instanceof Error ? error.message : "HumanLabelResolution is invalid",
      ));
      continue;
    }
    const resolutionResults = resolution.results.map((result) => `sha256:${result.digest.sha256}`).sort(compare);
    if (
      `sha256:${resolution.task.digest.sha256}` !== member.taskDigest ||
      !sameStrings(resolutionResults, member.resultDigests)
    ) {
      diagnostics.push(diagnostic(
        "LABEL_RESOLUTION_SUBJECT_MISMATCH",
        path,
        "HumanLabelResolution does not bind the member's exact Task and Result set",
      ));
      continue;
    }
    if (resolution.basis.kind === "independent-human-evaluations") {
      const considered = new Set(member.evaluations.considered.map(referenceKey));
      const admitted = new Set(member.evaluations.admitted.map(referenceKey));
      const resolutionIsAdmitted = member.labelResolutions.admitted.some(
        (candidate) => referenceKey(candidate) === referenceKey(reference),
      );
      const basis = resolution.basis.evaluations.map(referenceKey);
      const claims = basis.map((key) => evaluations.get(key));
      const reviewers = claims.flatMap((claim) => claim === undefined ? [] : [claim.statement.predicate.evaluator.id]).sort(compare);
      const opinions = claims.flatMap((claim) => {
        if (claim === undefined) return [];
        const opinion = humanOpinion(claim);
        return opinion === undefined ? [] : [opinion];
      });
      if (
        basis.some((key) => !considered.has(key)) ||
        (resolutionIsAdmitted && basis.some((key) => !admitted.has(key))) ||
        claims.some((claim) => claim === undefined) ||
        !sameStrings(reviewers, resolution.basis.reviewers) ||
        opinions.length !== claims.length ||
        !resolutionMatchesOpinions(resolution, opinions)
      ) {
        diagnostics.push(diagnostic(
          "LABEL_RESOLUTION_BASIS_MISMATCH",
          path,
          "HumanLabelResolution is not exactly derived from the selected independent human evaluations",
        ));
        continue;
      }
    }
    labelResolutions.set(referenceKey(reference), resolution);
  }

  return {
    member,
    execution,
    evaluations,
    verifications: verifications as VerifiedCohortMember["verifications"],
    labelResolutions,
  };
}

export function verifyEvidenceCohort(
  input: VerifyEvidenceCohortInput,
): EvidenceCohortVerification {
  const diagnostics: CohortDiagnostic[] = [];
  let cohort;
  let manifest;
  try {
    cohort = parseEvidenceCohort(input.cohortBytes);
  } catch (error) {
    return { conforms: false, diagnostics: [diagnostic(
      "COHORT_INVALID", "", error instanceof Error ? error.message : "invalid cohort",
    )] };
  }
  try {
    manifest = parseBenchmarkAnalysisManifest(input.manifestBytes);
  } catch (error) {
    return { conforms: false, diagnostics: [diagnostic(
      "MANIFEST_INVALID", "", error instanceof Error ? error.message : "invalid manifest",
    )] };
  }
  if (documentDigest(input.manifestBytes).slice(7) !== cohort.manifest.digest.sha256) {
    diagnostics.push(diagnostic(
      "RECORD_DIGEST_MISMATCH", "/manifest", "cohort does not bind the supplied manifest bytes",
    ));
  }
  const members = cohort.members.flatMap((member, index) => {
    const verified = verifyMember(member, index, input, diagnostics);
    return verified === undefined ? [] : [verified];
  });
  diagnostics.sort((left, right) => compare(left.path, right.path) || compare(left.code, right.code));
  return diagnostics.length === 0
    ? { conforms: true, cohort, manifest, members, diagnostics: [] }
    : { conforms: false, diagnostics };
}
