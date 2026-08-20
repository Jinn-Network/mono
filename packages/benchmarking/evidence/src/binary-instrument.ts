// SPDX-License-Identifier: Apache-2.0

import {
  projectBinaryInstrumentQualification,
  validateBinaryInstrumentQualificationProjection,
  type BinaryInstrumentItemContext,
  type BinaryInstrumentItemDecision,
  type BinaryInstrumentExcludedItem,
  type BinaryInstrumentReducedCall,
  type BinaryInstrumentReduction,
} from "@jinn-network/benchmarking-aggregate";
import {
  evidenceReferenceKey,
  type EvidenceRecordReference,
} from "@jinn-network/benchmarking-protocol";
import type { ResultEvaluationEvidence } from "@jinn-network/evidence-protocol";

import type { VerifiedEvidenceCohort, VerifiedCohortMember } from "./types.js";

export interface EvidenceBinaryInstrumentContext {
  readonly memberKey: string;
  readonly candidateClass: string;
  readonly stratum: string;
}

export interface EvidenceBinaryInstrumentInput {
  readonly cohort: VerifiedEvidenceCohort;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly instruments: readonly {
    readonly armId: string;
    readonly instrumentSha256: `sha256:${string}`;
  }[];
  readonly contexts: readonly EvidenceBinaryInstrumentContext[];
  readonly analysisContextSha256: `sha256:${string}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function measurement(evaluation: ResultEvaluationEvidence, name: string): unknown {
  return evaluation.statement.predicate.measurements?.find((entry) => entry.name === name)?.value;
}

function methodDigest(evaluation: ResultEvaluationEvidence): string | undefined {
  const descriptor = evaluation.statement.predicate.evaluationMethod ?? evaluation.statement.predicate.evaluationSpecification;
  return descriptor === undefined ? undefined : `sha256:${descriptor.digest.sha256}`;
}

function admittedResolution(member: VerifiedCohortMember) {
  const references = member.member.labelResolutions.admitted;
  if (references.length !== 1) throw new TypeError(`${member.member.memberKey} requires exactly one admitted human label resolution`);
  const resolution = member.labelResolutions.get(evidenceReferenceKey(references[0]!));
  if (resolution === undefined || resolution.resolution.status !== "admitted") {
    throw new TypeError(`${member.member.memberKey} lacks an admitted human label`);
  }
  return { reference: references[0]!, label: resolution.resolution.label };
}

function callFrom(
  member: VerifiedCohortMember,
  reference: EvidenceRecordReference,
  evaluation: ResultEvaluationEvidence,
  armId: string,
  instrumentSha256: string,
  context: BinaryInstrumentItemContext,
  replicate: number,
): BinaryInstrumentReducedCall | undefined {
  const opinion = measurement(evaluation, "binary-opinion") ?? measurement(evaluation, "judgeDecision");
  const parseValid = measurement(evaluation, "parseValid");
  if (opinion !== "ACCEPT" && opinion !== "REJECT") return undefined;
  if (parseValid !== undefined && typeof parseValid !== "boolean") return undefined;
  return {
    cellKey: `${member.member.memberKey}/${armId}/${replicate}`,
    taskDigest: member.member.taskDigest.slice(7),
    armId,
    replicate,
    verdictDigest: `sha256:${reference.record.digest.sha256}`,
    verdict: opinion === "ACCEPT" ? "pass" : "fail",
    judgeDecision: opinion,
    parseValid: parseValid ?? true,
    instrumentSha256: instrumentSha256.slice(7),
    context,
  };
}

export function reduceEvidenceBinaryInstrument(
  input: EvidenceBinaryInstrumentInput,
): BinaryInstrumentReduction {
  const k = input.parameters["k"];
  if (!Number.isSafeInteger(k) || Number(k) < 1 || Number(k) % 2 === 0) {
    throw new TypeError("binary-instrument k must be an odd positive integer");
  }
  const requiredCalls = Number(k);
  const contextByMember = new Map(input.contexts.map((entry) => [entry.memberKey, entry]));
  const instrumentByDigest = new Map(input.instruments.map((entry) => [entry.instrumentSha256, entry]));
  if (instrumentByDigest.size !== input.instruments.length) throw new TypeError("instrument digests must be unique");
  const items: BinaryInstrumentItemDecision[] = [];
  const evaluatedCalls: BinaryInstrumentReducedCall[] = [];
  const excluded: BinaryInstrumentExcludedItem[] = [];
  for (const member of input.cohort.members) {
    const declaredContext = contextByMember.get(member.member.memberKey);
    if (declaredContext === undefined) throw new TypeError(`missing analysis context for ${member.member.memberKey}`);
    const label = admittedResolution(member);
    const context: BinaryInstrumentItemContext = {
      analysisContextSha256: input.analysisContextSha256.slice(7),
      truthLabel: label.label === "ACCEPT" ? "CORRECT" : "WRONG",
      candidateClass: declaredContext.candidateClass,
      stratum: declaredContext.stratum,
      labelResolutionSha256: label.reference.record.digest.sha256,
    };
    for (const instrument of [...input.instruments].sort((left, right) => compare(left.armId, right.armId))) {
      const candidates = member.member.evaluations.admitted
        .flatMap((reference) => {
          const evaluation = member.evaluations.get(evidenceReferenceKey(reference));
          return evaluation !== undefined && methodDigest(evaluation) === instrument.instrumentSha256
            ? [{ reference, evaluation }]
            : [];
        })
        .sort((left, right) => compare(left.reference.record.digest.sha256, right.reference.record.digest.sha256));
      if (candidates.length > requiredCalls) {
        throw new TypeError(`${member.member.memberKey}/${instrument.armId} has ${candidates.length} admitted calls; expected at most ${requiredCalls}`);
      }
      const calls = candidates.map(({ reference, evaluation }, index) => callFrom(
          member,
          reference,
          evaluation,
          instrument.armId,
          instrument.instrumentSha256,
          context,
          index + 1,
        ));
      const decisive = calls.filter((call): call is BinaryInstrumentReducedCall => call !== undefined);
      evaluatedCalls.push(...decisive);
      const cellKeys = Array.from(
        { length: requiredCalls },
        (_, index) => `${member.member.memberKey}/${instrument.armId}/${index + 1}`,
      );
      if (decisive.length !== requiredCalls) {
        const inconclusiveCellKeys = calls.flatMap((call, index) => call === undefined ? [cellKeys[index]!] : []);
        const missingCellKeys = cellKeys.slice(candidates.length);
        excluded.push({
          taskDigest: member.member.taskDigest.slice(7),
          armId: instrument.armId,
          instrumentSha256: instrument.instrumentSha256.slice(7),
          context,
          cellKeys,
          reasons: [
            ...(inconclusiveCellKeys.length === 0 ? [] : [{
              reason: "inconclusive-evaluation" as const,
              cellKeys: inconclusiveCellKeys,
            }]),
            ...(missingCellKeys.length === 0 ? [] : [{
              reason: "missing-evaluation" as const,
              cellKeys: missingCellKeys,
            }]),
          ],
        });
        continue;
      }
      const accepted = decisive.filter(({ judgeDecision }) => judgeDecision === "ACCEPT").length;
      const rejected = decisive.length - accepted;
      items.push({
        taskDigest: member.member.taskDigest.slice(7),
        armId: instrument.armId,
        instrumentSha256: instrument.instrumentSha256.slice(7),
        context,
        cellKeys,
        calls: decisive,
        accepted,
        rejected,
        decision: accepted > rejected ? "ACCEPT" : "REJECT",
        unstable: accepted !== 0 && rejected !== 0,
      });
    }
  }
  const order = (left: { taskDigest: string; armId: string }, right: { taskDigest: string; armId: string }) =>
    compare(`${left.taskDigest}\u0000${left.armId}`, `${right.taskDigest}\u0000${right.armId}`);
  return {
    subjectSha256: input.analysisContextSha256.slice(7),
    k: requiredCalls,
    items: items.sort(order),
    evaluatedCalls: evaluatedCalls.sort((left, right) => compare(left.cellKey, right.cellKey)),
    excluded: [...excluded].sort(order),
    conflicted: { count: 0, cellKeys: [] },
  };
}

export function computeEvidenceBinaryInstrumentQualification(input: EvidenceBinaryInstrumentInput): unknown {
  const reduction = reduceEvidenceBinaryInstrument(input);
  const qualification = projectBinaryInstrumentQualification({
    parameters: input.parameters,
    reduction,
    instruments: input.instruments,
  });
  const validation = validateBinaryInstrumentQualificationProjection(qualification);
  if (!validation.ok) throw new TypeError(`evidence-native qualification is invalid: ${validation.issues.join("; ")}`);
  return qualification;
}
