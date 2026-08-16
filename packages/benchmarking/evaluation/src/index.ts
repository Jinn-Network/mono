// SPDX-License-Identifier: Apache-2.0

import {
  commitPreparedAttestation,
  prepareResultEvaluation,
  type AttestationCommitReceipt,
  type AttestationResourceReference,
  type DsseSigner,
  type PrepareResultEvaluationInput,
  type PreparedResultEvaluation,
} from "@jinn-network/attestation-issuer";
import {
  HUMAN_LABEL_RESOLUTION_MEDIA_TYPE,
  parseHumanLabelResolutionPayload,
  sealHumanLabelResolutionPayload,
  type DigestBearingResourceDescriptor,
  type EvidenceRecordReference as BenchmarkEvidenceRecordReference,
  type EvidenceRecordReference as BenchmarkingEvidenceReference,
  type HumanLabelResolution,
} from "@jinn-network/benchmarking-protocol";
import { validateResultEvaluation } from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { sealSignedPayload, type DsseSigner as TrustDsseSigner } from "@jinn-network/trust-core";

export interface IssueResultEvaluationInput
  extends Omit<PrepareResultEvaluationInput, "evidence"> {
  readonly supportingEvaluatorExecution?: EvidenceRecordReference;
  readonly evidence?: readonly AttestationResourceReference[];
}

export interface IssueResultEvaluationDependencies {
  readonly signer: DsseSigner;
  readonly repository: EvidenceRepository;
  readonly signal?: AbortSignal;
}

export interface IssuedResultEvaluation {
  readonly prepared: PreparedResultEvaluation;
  readonly commit: AttestationCommitReceipt<"result-evaluation">;
  readonly reference: BenchmarkEvidenceRecordReference;
}

export async function issueResultEvaluation(
  input: IssueResultEvaluationInput,
  dependencies: IssueResultEvaluationDependencies,
): Promise<IssuedResultEvaluation> {
  if (input.supportingEvaluatorExecution !== undefined && input.supportingEvaluatorExecution.family !== "execution-evidence") {
    throw new TypeError("supportingEvaluatorExecution must reference Execution Evidence");
  }
  const supporting: AttestationResourceReference[] = input.supportingEvaluatorExecution === undefined ? [] : [{
    name: "ro-crate-metadata.json",
    digest: input.supportingEvaluatorExecution.digest,
    mediaType: "application/ld+json",
    annotations: {
      "https://spec.jinn.network/relationships/supporting-evaluator-execution": true,
    },
  }];
  const prepared = await prepareResultEvaluation(
    {
      ...input,
      evidence: [...(input.evidence ?? []), ...supporting],
    },
    dependencies.signer,
    dependencies.signal === undefined ? undefined : { signal: dependencies.signal },
  );
  const commit = await commitPreparedAttestation(
    prepared,
    dependencies.repository,
    dependencies.signal === undefined ? undefined : { signal: dependencies.signal },
  );
  return {
    prepared,
    commit,
    reference: {
      family: "result-evaluation",
      record: {
        name: "result-evaluation.dsse.json",
        digest: { sha256: prepared.recordDigest.slice(7) },
        mediaType: "application/vnd.dsse.envelope.v1+json",
      },
    },
  };
}

export type HumanOpinion = "ACCEPT" | "REJECT" | "inconclusive";

export interface IssueHumanResultEvaluationInput {
  readonly task: AttestationResourceReference;
  readonly results: readonly [AttestationResourceReference, ...AttestationResourceReference[]];
  readonly reviewer: PrepareResultEvaluationInput["evaluator"];
  readonly completedAt: string;
  readonly opinion: HumanOpinion;
  readonly evaluationSpecification: AttestationResourceReference;
  readonly response: AttestationResourceReference;
  readonly blindVisibilityReceipt: AttestationResourceReference;
  readonly explanation?: string;
}

/** Issues the human's opinion directly over the original Task+Result pair. */
export async function issueHumanResultEvaluation(
  input: IssueHumanResultEvaluationInput,
  dependencies: IssueResultEvaluationDependencies,
): Promise<IssuedResultEvaluation> {
  return issueResultEvaluation({
    task: input.task,
    results: input.results,
    evaluator: input.reviewer,
    evaluatedAt: input.completedAt,
    verdict: input.opinion === "ACCEPT" ? "pass" : input.opinion === "REJECT" ? "fail" : "inconclusive",
    evaluationSpecification: input.evaluationSpecification,
    measurements: [
      { name: "humanLabel", value: input.opinion },
      { name: "blindIndependentReview", value: true },
    ],
    evidence: [input.response, input.blindVisibilityReceipt],
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
    limitations: ["reviewer-person-distinctness-requires-external-identity-policy"],
  }, dependencies);
}

export interface HumanLabelResolutionStore {
  put(bytes: Uint8Array): Promise<{ readonly reference: BenchmarkingEvidenceReference }>;
}

export interface ResolveHumanEvaluation {
  resolve(reference: BenchmarkingEvidenceReference): Promise<Uint8Array | null>;
}

export interface IssueHumanLabelResolutionInput {
  readonly task: DigestBearingResourceDescriptor;
  readonly results: readonly [DigestBearingResourceDescriptor, ...DigestBearingResourceDescriptor[]];
  readonly evaluationReferences: readonly BenchmarkingEvidenceReference[];
  readonly policy: HumanLabelResolution["policy"];
  readonly admittingOperator: `${string}:${string}`;
  readonly publisher: `${string}:${string}`;
  readonly issuer: `${string}:${string}`;
  readonly resolvedAt: string;
}

export interface IssuedHumanLabelResolution {
  readonly payload: HumanLabelResolution;
  readonly payloadBytes: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly reference: BenchmarkingEvidenceReference;
}

interface HumanLabelResolutionIssueDependencies {
  readonly signer: TrustDsseSigner;
  readonly store: HumanLabelResolutionStore;
  readonly signal?: AbortSignal;
}

async function signAndStoreHumanLabelResolution(
  payload: ReturnType<typeof sealHumanLabelResolutionPayload>,
  dependencies: HumanLabelResolutionIssueDependencies,
): Promise<IssuedHumanLabelResolution> {
  const signed = await sealSignedPayload({
    payloadBytes: payload.bytes,
    payloadType: HUMAN_LABEL_RESOLUTION_MEDIA_TYPE,
    signer: dependencies.signer,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });
  const stored = await dependencies.store.put(signed.envelopeBytes);
  if (stored.reference.family !== "human-label-resolution" || stored.reference.record.digest.sha256 !== signed.recordDigest.slice(7)) {
    throw new TypeError("human label resolution store returned the wrong record identity");
  }
  return {
    payload: parseHumanLabelResolutionPayload(signed.payloadBytes),
    payloadBytes: signed.payloadBytes,
    envelopeBytes: signed.envelopeBytes,
    reference: stored.reference,
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evaluationOpinion(bytes: Uint8Array, taskDigest: string, resultDigests: readonly string[]) {
  const report = validateResultEvaluation(bytes);
  if (!report.conforms || report.value === undefined) throw new TypeError("human evaluation is not conforming Result Evaluation");
  const evidence = report.value;
  const byName = new Map(evidence.statement.subject.map((subject) => [subject.name, subject]));
  const task = byName.get(evidence.statement.predicate.taskSubject);
  const results = evidence.statement.predicate.resultSubjects.map((name) => byName.get(name));
  if (
    task === undefined || `sha256:${task.digest.sha256}` !== taskDigest ||
    results.some((result) => result === undefined) ||
    results.map((result) => `sha256:${result!.digest.sha256}`).sort(compare).join("\u0000") !== [...resultDigests].sort(compare).join("\u0000")
  ) {
    throw new TypeError("human evaluation does not bind the exact Task and Result set");
  }
  const label = evidence.statement.predicate.measurements?.find(({ name }) => name === "humanLabel")?.value;
  if (label !== "ACCEPT" && label !== "REJECT" && label !== "inconclusive") {
    throw new TypeError("human evaluation lacks a recognized humanLabel measurement");
  }
  return { reviewer: evidence.statement.predicate.evaluator.id, label } as const;
}

/** Resolves and checks every individual human claim before issuing the derived admission. */
export async function issueHumanLabelResolution(
  input: IssueHumanLabelResolutionInput,
  dependencies: {
    readonly signer: TrustDsseSigner;
    readonly evaluations: ResolveHumanEvaluation;
    readonly store: HumanLabelResolutionStore;
    readonly signal?: AbortSignal;
  },
): Promise<IssuedHumanLabelResolution> {
  if (input.evaluationReferences.length !== input.policy.requiredReviewers) {
    throw new TypeError("evaluation count must equal the registered reviewer requirement");
  }
  const evaluations = [...input.evaluationReferences].sort((left, right) =>
    compare(`${left.family}\u0000${left.record.digest.sha256}`, `${right.family}\u0000${right.record.digest.sha256}`));
  if (new Set(evaluations.map((reference) => reference.record.digest.sha256)).size !== evaluations.length) {
    throw new TypeError("human evaluation references must be unique");
  }
  const resultDigests = input.results.map((result) => `sha256:${result.digest.sha256}`).sort(compare);
  const opinions: { readonly reviewer: string; readonly label: HumanOpinion }[] = [];
  for (const reference of evaluations) {
    if (reference.family !== "result-evaluation") throw new TypeError("human review basis must contain Result Evaluations");
    const bytes = await dependencies.evaluations.resolve(reference);
    if (bytes === null) throw new TypeError("human evaluation bytes are unavailable");
    opinions.push(evaluationOpinion(bytes, `sha256:${input.task.digest.sha256}`, resultDigests));
  }
  const reviewers = opinions.map(({ reviewer }) => reviewer).sort(compare);
  if (new Set(reviewers).size !== reviewers.length) throw new TypeError("human reviewers must be distinct");
  const decisive = opinions.map(({ label }) => label);
  const resolution: HumanLabelResolution["resolution"] = decisive.every((label) => label === "ACCEPT")
    ? { status: "admitted", label: "ACCEPT" }
    : decisive.every((label) => label === "REJECT")
      ? { status: "admitted", label: "REJECT" }
      : decisive.includes("inconclusive")
        ? { status: "unresolved", reason: "inconclusive" }
        : { status: "unresolved", reason: "disagreement" };
  const sealedPayload = sealHumanLabelResolutionPayload({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v2",
    task: input.task,
    results: [...input.results].sort((left, right) => compare(left.digest.sha256, right.digest.sha256)),
    policy: input.policy,
    basis: { kind: "independent-human-evaluations", evaluations, reviewers },
    resolution,
    admittingOperator: input.admittingOperator,
    publisher: input.publisher,
    issuer: input.issuer,
    resolvedAt: input.resolvedAt,
  });
  return signAndStoreHumanLabelResolution(sealedPayload, dependencies);
}

export interface IssueAuthoritativeLabelResolutionInput {
  readonly task: DigestBearingResourceDescriptor;
  readonly results: readonly [DigestBearingResourceDescriptor, ...DigestBearingResourceDescriptor[]];
  readonly policy: HumanLabelResolution["policy"];
  readonly authority: `${string}:${string}`;
  readonly source: DigestBearingResourceDescriptor;
  readonly label: "ACCEPT" | "REJECT";
  readonly admittingOperator: `${string}:${string}`;
  readonly publisher: `${string}:${string}`;
  readonly issuer: `${string}:${string}`;
  readonly resolvedAt: string;
}

/** Admits a separately identified authoritative label without fabricating human reviews. */
export async function issueAuthoritativeLabelResolution(
  input: IssueAuthoritativeLabelResolutionInput,
  dependencies: HumanLabelResolutionIssueDependencies,
): Promise<IssuedHumanLabelResolution> {
  const sealedPayload = sealHumanLabelResolutionPayload({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v2",
    task: input.task,
    results: [...input.results].sort((left, right) => compare(left.digest.sha256, right.digest.sha256)),
    policy: input.policy,
    basis: {
      kind: "authoritative-label-import",
      authority: input.authority,
      source: input.source,
    },
    resolution: { status: "admitted", label: input.label },
    admittingOperator: input.admittingOperator,
    publisher: input.publisher,
    issuer: input.issuer,
    resolvedAt: input.resolvedAt,
  });
  return signAndStoreHumanLabelResolution(sealedPayload, dependencies);
}
