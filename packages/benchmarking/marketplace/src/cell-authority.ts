// SPDX-License-Identifier: MIT

import type { InScopeCell, InScopeVerdict } from "@jinn-network/benchmarking-run";
import {
  cellIdempotencyKey,
  parseCellKey,
  submissionExtensionBlock,
} from "@jinn-network/benchmarking-records";
import type { MarketplaceProjectionState, MarketplaceProtocolObservation } from "@jinn-network/marketplace-projector";
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  validateDelivery,
  validateSubmission,
} from "@jinn-network/task-execution-protocol";
import type {
  AttemptCreationAuthority,
  AttemptObservationAuthority,
  AuthorityProjection,
} from "./authority-projection.js";
import {
  indexAttemptCreations,
  indexAttemptObservations,
  indexAttemptTerminals,
  indexDeliveryObservations,
  indexVerdictSettlements,
} from "./authority-projection.js";
import { bytesMatchCanonicalSeal, decodeUtf8Json } from "./canonical-bytes.js";

/** Benchmarking Submission extension block key (Addendum 2026-07-28-b). */
export const BENCHMARKING_CELL_EXTENSION = "jinn.benchmarking/cell";

export interface SealedRecordMaterialPort {
  sealedSubmissionBytes(input: {
    submissionUrn: string;
    taskDigest: `sha256:${string}`;
  }): Promise<Uint8Array | undefined> | Uint8Array | undefined;
  sealedDeliveryBytes?(input: {
    attemptUrn: `urn:uuid:${string}`;
    deliveryDigest: `sha256:${string}`;
  }): Promise<Uint8Array | undefined> | Uint8Array | undefined;
  sealedVerdictDeliveryBytes?(input: {
    attemptUrn: `urn:uuid:${string}`;
    verdictIndex: number;
    deliveryDigest: `sha256:${string}`;
  }): Promise<Uint8Array | undefined> | Uint8Array | undefined;
}

/** @deprecated Use {@link SealedRecordMaterialPort}. */
export type SealedSubmissionMaterialPort = SealedRecordMaterialPort;

export interface ProjectorCellJoinCandidate {
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly taskDigest: string;
  readonly dispatches: number;
  readonly accounted?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function taskDigestRef(taskDigest: string): `sha256:${string}` {
  return (taskDigest.startsWith("sha256:") ? taskDigest : `sha256:${taskDigest}`) as `sha256:${string}`;
}

function addressEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function submissionAcceptedFor(
  observations: readonly MarketplaceProtocolObservation[],
  submissionUrn: string,
  taskDigest: string,
): MarketplaceProtocolObservation | undefined {
  const taskRef = taskDigestRef(taskDigest);
  return observations.find((observation) => {
    if (observation.type !== "network.jinn.task-execution.submission-accepted.v1") return false;
    if (observation.subject !== submissionUrn) return false;
    const data = observation.data;
    return isRecord(data) && data.task === taskRef;
  });
}

function anchoredDigestForObservation(
  observation: MarketplaceProtocolObservation,
  state: MarketplaceProjectionState,
): `sha256:${string}` | undefined {
  for (const task of Object.values(state.tasks)) {
    if (task.admission === "rejected") continue;
    const anchor = task.submissionAnchor;
    if (anchor === undefined) continue;
    if (
      anchor.derivation.txHash === observation.derivation.txHash
      && anchor.derivation.logIndex === observation.derivation.logIndex
    ) {
      return anchor.digest;
    }
  }
  return undefined;
}

function extensionFromSubmission(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const block = doc[BENCHMARKING_CELL_EXTENSION];
  return isRecord(block) ? block : undefined;
}

async function resolveCanonicalSubmission(input: {
  submissionUrn: string;
  taskDigest: string;
  material?: SealedRecordMaterialPort;
}): Promise<{ bytes: Uint8Array; digest: `sha256:${string}`; doc: Record<string, unknown> } | undefined> {
  if (input.material === undefined) return undefined;
  const bytes = await input.material.sealedSubmissionBytes({
    submissionUrn: input.submissionUrn,
    taskDigest: taskDigestRef(input.taskDigest),
  });
  if (bytes === undefined) return undefined;
  const parsed = decodeUtf8Json(bytes);
  if (parsed === undefined || !isRecord(parsed)) return undefined;
  const validation = validateSubmission(parsed);
  if (!bytesMatchCanonicalSeal(bytes, parsed, sealSubmission, validation)) return undefined;
  return {
    bytes,
    digest: documentDigest(bytes) as `sha256:${string}`,
    doc: parsed,
  };
}

async function resolveCanonicalDelivery(input: {
  attemptUrn: `urn:uuid:${string}`;
  deliveryDigest: `sha256:${string}`;
  material?: SealedRecordMaterialPort;
}): Promise<{ bytes: Uint8Array; digest: `sha256:${string}` } | undefined> {
  if (input.material?.sealedDeliveryBytes === undefined) return undefined;
  const bytes = await input.material.sealedDeliveryBytes({
    attemptUrn: input.attemptUrn,
    deliveryDigest: input.deliveryDigest,
  });
  if (bytes === undefined) return undefined;
  const parsed = decodeUtf8Json(bytes);
  if (parsed === undefined || !isRecord(parsed)) return undefined;
  const validation = validateDelivery(parsed);
  if (!bytesMatchCanonicalSeal(bytes, parsed, sealDelivery, validation)) return undefined;
  const digest = documentDigest(bytes) as `sha256:${string}`;
  if (digest !== input.deliveryDigest) return undefined;
  return { bytes, digest };
}

interface ValidatedAttemptCandidate {
  attemptUrn: `urn:uuid:${string}`;
  engaged: AttemptObservationAuthority;
  creation: AttemptCreationAuthority;
  submission: { bytes: Uint8Array; digest: `sha256:${string}` };
  hasDelivery: boolean;
  deliveryDigest?: `sha256:${string}`;
}

/**
 * Deterministic attempt selection (program §7.138): prefer the unique delivered Attempt when
 * present; otherwise the highest monotonic attemptIndex among eligible candidates.
 */
export function selectAccountedAttempt(
  candidates: readonly ValidatedAttemptCandidate[],
): ValidatedAttemptCandidate | undefined {
  if (candidates.length === 0) return undefined;

  const delivered = candidates.filter((candidate) => candidate.hasDelivery);
  if (delivered.length > 1) {
    const attemptUrns = new Set(delivered.map((candidate) => candidate.attemptUrn));
    if (attemptUrns.size > 1) return undefined;
  }
  if (delivered.length >= 1) return delivered[0];

  return candidates.reduce((best, candidate) =>
    candidate.creation.attemptIndex > best.creation.attemptIndex ? candidate : best
  );
}

/**
 * Package-enforced cell authority (program §7.138). Host join supplies coordinates only; every
 * authority-bearing field is derived from the private authority projection plus exact material.
 */
export async function authorizeCellFromProjection(input: {
  runDigest: string;
  candidate: ProjectorCellJoinCandidate;
  projection: AuthorityProjection;
  material?: SealedRecordMaterialPort;
}): Promise<InScopeCell | undefined> {
  const { runDigest, candidate, projection, material } = input;
  const { observations, events, state } = projection;

  let coordinate;
  try {
    coordinate = parseCellKey(candidate.cellKey);
  } catch {
    return undefined;
  }
  if (
    coordinate.armId !== candidate.armId
    || coordinate.replicate !== candidate.replicate
    || coordinate.taskDigest !== candidate.taskDigest
  ) {
    return undefined;
  }

  const dispatch = candidate.accounted ?? candidate.dispatches;
  if (!Number.isSafeInteger(dispatch) || dispatch < 1) return undefined;

  const attemptObservations = indexAttemptObservations(observations);
  const attemptCreations = indexAttemptCreations(events);
  const deliveryObservations = indexDeliveryObservations(observations);
  const verdictSettlements = indexVerdictSettlements(events);
  const attemptTerminals = indexAttemptTerminals(observations);

  const validatedCandidates: ValidatedAttemptCandidate[] = [];

  for (const engaged of attemptObservations.values()) {
    if (engaged.taskDigest !== taskDigestRef(candidate.taskDigest)) continue;

    const accepted = submissionAcceptedFor(observations, engaged.submissionUrn, candidate.taskDigest);
    if (accepted === undefined) continue;

    const submission = await resolveCanonicalSubmission({
      submissionUrn: engaged.submissionUrn,
      taskDigest: candidate.taskDigest,
      material,
    });
    if (submission === undefined) continue;

    const extension = extensionFromSubmission(submission.doc);
    if (extension === undefined) continue;
    const expectedExtension = submissionExtensionBlock(runDigest, candidate.cellKey, candidate.armId);
    if (
      extension.run !== expectedExtension.run
      || extension.cellKey !== expectedExtension.cellKey
      || extension.armId !== expectedExtension.armId
    ) {
      continue;
    }
    if (submission.doc.submission !== engaged.submissionUrn) continue;
    if (submission.doc.idempotencyKey !== cellIdempotencyKey(runDigest, candidate.cellKey, dispatch)) {
      continue;
    }

    const acceptedGeneration = accepted.derivation.contractGeneration;
    const anchoredDigest = anchoredDigestForObservation(accepted, state);
    if (acceptedGeneration === "revised" && anchoredDigest === undefined) continue;
    if (anchoredDigest !== undefined && anchoredDigest !== submission.digest) continue;

    const creation = attemptCreations.get(engaged.attemptUrn);
    if (creation === undefined || creation.requestId !== engaged.requestId) continue;
    if (!addressEqual(creation.operator, engaged.executor)) continue;
    if (creation.generation !== acceptedGeneration) continue;
    if (engaged.generation !== acceptedGeneration) continue;

    const deliveryObserved = deliveryObservations.get(engaged.attemptUrn);
    validatedCandidates.push({
      attemptUrn: engaged.attemptUrn,
      engaged,
      creation,
      submission: { bytes: submission.bytes, digest: submission.digest },
      hasDelivery: deliveryObserved !== undefined,
      ...(deliveryObserved !== undefined ? { deliveryDigest: deliveryObserved.digest } : {}),
    });
  }

  const selected = selectAccountedAttempt(validatedCandidates);
  if (selected === undefined) return undefined;

  const { attemptUrn, engaged, submission } = selected;
  const deliveryObserved = deliveryObservations.get(attemptUrn);
  let deliveryBytes: Uint8Array | undefined;
  let deliveryDigest: `sha256:${string}` | undefined;
  if (deliveryObserved !== undefined) {
    const delivery = await resolveCanonicalDelivery({
      attemptUrn,
      deliveryDigest: deliveryObserved.digest,
      material,
    });
    if (delivery === undefined) return undefined;
    deliveryBytes = delivery.bytes;
    deliveryDigest = delivery.digest;
  }

  const verdicts: InScopeVerdict[] = [];
  for (const verdictSettlement of verdictSettlements) {
    if (verdictSettlement.attemptUrn !== attemptUrn) continue;
    if (verdictSettlement.evaluationDeliveryDigest === undefined) continue;
    let record: InScopeVerdict["record"] = {
      evaluator: verdictSettlement.evaluator,
    };
    if (verdictSettlement.verdictCode === 1) record = { ...record, verdict: "pass" };
    if (verdictSettlement.verdictCode === 2) record = { ...record, verdict: "fail" };
    if (material?.sealedVerdictDeliveryBytes !== undefined) {
      const bytes = await material.sealedVerdictDeliveryBytes({
        attemptUrn,
        verdictIndex: verdictSettlement.verdictIndex,
        deliveryDigest: verdictSettlement.evaluationDeliveryDigest,
      });
      if (bytes !== undefined) {
        const parsed = decodeUtf8Json(bytes);
        if (parsed !== undefined && isRecord(parsed)) {
          const digest = documentDigest(bytes) as `sha256:${string}`;
          if (digest === verdictSettlement.evaluationDeliveryDigest) {
            record = parsed as InScopeVerdict["record"];
          }
        }
      }
    }
    verdicts.push({
      digest: verdictSettlement.evaluationDeliveryDigest,
      record,
    });
  }

  const terminal = attemptTerminals.get(attemptUrn);
  const evaluationTerminal = terminal !== undefined
    && terminal.state === "failed"
    && terminal.category === "result-unavailable"
    ? "could-not-grade" as const
    : undefined;

  return {
    cellKey: candidate.cellKey,
    armId: candidate.armId,
    replicate: candidate.replicate,
    taskDigest: candidate.taskDigest,
    dispatches: candidate.dispatches,
    accounted: candidate.accounted ?? candidate.dispatches,
    submissionBytes: submission.bytes,
    submissionDigest: submission.digest,
    attempt: attemptUrn,
    ...(deliveryDigest !== undefined ? { deliveryDigest, deliveryBytes } : {}),
    verdicts,
    ...(evaluationTerminal !== undefined ? { evaluationTerminal } : {}),
    evidenceRef: {
      observationId: engaged.observationId,
      submissionUrn: engaged.submissionUrn,
      attemptUrn,
    },
  };
}

/** @deprecated Use {@link authorizeCellFromProjection}. */
export const validateAuthorizedInScopeCell = authorizeCellFromProjection;

export type ProjectorCellEvidenceRef = {
  observationId: string;
  submissionUrn: string;
  attemptUrn?: string;
};
