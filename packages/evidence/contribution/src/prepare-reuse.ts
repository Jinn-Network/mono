// SPDX-License-Identifier: Apache-2.0
import { hashExactBytes } from "@jinn-network/evidence-publication";
import { recordDigest } from "@jinn-network/evidence-protocol";
import type {
  EvidenceArtifactReference,
  EvidenceRecordFamily,
  EvidenceRecordReference,
  EvidenceRepository,
  RepositoryWriteReceipt,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";
import { createPreparedDisclosureManifest, parsePreparedDisclosureManifest } from
  "./manifest.js";
import type { LoadedEvidenceSource, RepositoryResolver } from "./source.js";
import type {
  ContributionDestination,
  ContributionOperationOptions,
  ContributionRequestId,
  PreviewReadyPreparation,
  VerifiedReuseDecision,
} from "./types.js";

function assertArtifactReceiptMatches(
  receipt: RepositoryWriteReceipt<EvidenceArtifactReference>,
  expected: EvidenceArtifactReference,
): void {
  if (receipt.reference.digest !== expected.digest) {
    throw new EvidenceContributionError("PORT_PROTOCOL_VIOLATION");
  }
}

function assertRecordReceiptMatches(
  receipt: RepositoryWriteReceipt<EvidenceRecordReference>,
  expected: EvidenceRecordReference,
): void {
  if (receipt.reference.digest !== expected.digest) {
    throw new EvidenceContributionError("PORT_PROTOCOL_VIOLATION");
  }
}

async function loadExactArtifact(
  repository: EvidenceRepository,
  reference: EvidenceArtifactReference,
  options?: ContributionOperationOptions,
): Promise<Uint8Array> {
  const bytes = await repository.getArtifact(reference, options);
  if (bytes === null) throw new EvidenceContributionError("SOURCE_NOT_FOUND");
  const snapshot = Uint8Array.from(bytes);
  if (recordDigest(snapshot) !== reference.digest) {
    throw new EvidenceContributionError("SOURCE_DIGEST_MISMATCH");
  }
  return snapshot;
}

async function loadExactRecord(
  repository: EvidenceRepository,
  reference: EvidenceRecordReference,
  options?: ContributionOperationOptions,
): Promise<Uint8Array> {
  const bytes = await repository.getRecord(reference, options);
  if (bytes === null) throw new EvidenceContributionError("SOURCE_NOT_FOUND");
  const snapshot = Uint8Array.from(bytes);
  if (recordDigest(snapshot) !== reference.digest) {
    throw new EvidenceContributionError("SOURCE_DIGEST_MISMATCH");
  }
  return snapshot;
}

export interface PrepareReusableDisclosureInput {
  readonly requestId: ContributionRequestId;
  readonly intentFingerprint: Sha256Digest;
  readonly source: LoadedEvidenceSource;
  readonly route: VerifiedReuseDecision;
  /**
   * Deviation from the plan's literal signature, matching the addition on
   * `prepareExecutionDisclosure` / `prepareSignedDisclosure`: reusing a
   * prior disclosure requires loading the prior manifest and its
   * referenced record/artifact bytes from a Repository, and the given
   * input carries no binding for it.
   */
  readonly sourceRepositoryBindingId: string;
  readonly stagingRepositoryBindingId: string;
  readonly destinations: readonly ContributionDestination[];
}

/**
 * Reuse an earlier prepared disclosure for a new request and new
 * destinations. Verifies the prior manifest's exact bytes against the
 * route's expected preview fingerprint, cross-checks the prior source,
 * prepared record, and (where applicable) policy/implementation identities
 * against the current route, reloads and digest-verifies every reused
 * record/artifact byte, and re-stages them for the new request. Never
 * imports the prior manifest's destination authorization -- new
 * destinations always produce new Publication bundle and payload
 * identities.
 */
export async function prepareReusableDisclosure(
  input: PrepareReusableDisclosureInput,
  repositories: RepositoryResolver,
  options?: ContributionOperationOptions,
): Promise<PreviewReadyPreparation> {
  const sourceRepository = await repositories.resolve(
    input.sourceRepositoryBindingId,
    options,
  );
  const stagingRepository = await repositories.resolve(
    input.stagingRepositoryBindingId,
    options,
  );

  const priorManifestBytes = await loadExactArtifact(
    sourceRepository,
    input.route.priorManifest,
    options,
  );
  if (
    hashExactBytes(priorManifestBytes) !== input.route.expectedPriorPreviewFingerprint
  ) {
    throw new EvidenceContributionError("POLICY_INVALID");
  }
  const priorManifest = parsePreparedDisclosureManifest(priorManifestBytes);

  if (
    priorManifest.source.family !== input.source.reference.family ||
    priorManifest.source.digest !== input.source.reference.digest
  ) {
    throw new EvidenceContributionError("POLICY_DENIED");
  }
  if (
    priorManifest.preparedRecord.family !== input.route.preparedRecord.family ||
    priorManifest.preparedRecord.digest !== input.route.preparedRecord.digest
  ) {
    throw new EvidenceContributionError("POLICY_DENIED");
  }
  if (
    (priorManifest.preparation.kind === "publishable-unchanged" ||
      priorManifest.preparation.kind === "derived") &&
    (priorManifest.preparation.policyDigest !== input.route.policyDigest ||
      priorManifest.preparation.implementationDigest !== input.route.implementationDigest)
  ) {
    throw new EvidenceContributionError("POLICY_DENIED");
  }

  const preparedRecordBytes = await loadExactRecord(
    sourceRepository,
    priorManifest.preparedRecord,
    options,
  );
  const stagedRecordReceipt = await stagingRepository.putRecord(
    priorManifest.preparedRecord.family as EvidenceRecordFamily,
    preparedRecordBytes,
    options,
  );
  assertRecordReceiptMatches(stagedRecordReceipt, priorManifest.preparedRecord);

  const stagedArtifacts: EvidenceArtifactReference[] = [];
  for (const artifact of priorManifest.artifacts) {
    const bytes = await loadExactArtifact(sourceRepository, artifact, options);
    const receipt = await stagingRepository.putArtifact(bytes, options);
    assertArtifactReceiptMatches(receipt, artifact);
    stagedArtifacts.push(receipt.reference);
  }

  const disclosure = createPreparedDisclosureManifest({
    requestId: input.requestId,
    intentFingerprint: input.intentFingerprint,
    source: input.source.reference,
    preparedRecord: stagedRecordReceipt.reference,
    artifacts: stagedArtifacts,
    preparation: {
      kind: "verified-reuse",
      priorPreviewFingerprint: input.route.expectedPriorPreviewFingerprint,
    },
    policyDecision: input.route.decision,
    destinations: input.destinations,
    ...(priorManifest.bindingImpact !== undefined
      ? { bindingImpact: priorManifest.bindingImpact }
      : {}),
    unavailableArtifacts: priorManifest.unavailableArtifacts,
    risk: priorManifest.risk,
  });
  return { status: "preview-ready", disclosure };
}
