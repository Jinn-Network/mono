// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import type {
  EvidenceArtifactReference,
  EvidenceRepository,
  RepositoryWriteReceipt,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";
import { createPreparedDisclosureManifest } from "./manifest.js";
import type { LoadedEvidenceSource, RepositoryResolver } from "./source.js";
import type {
  ContributionDestination,
  ContributionOperationOptions,
  ContributionRequestId,
  PreviewReadyPreparation,
  VerifiedSignedUnchangedDecision,
} from "./types.js";
import { toContributionCallOptions } from "./types.js";

function assertArtifactReceiptMatches(
  receipt: RepositoryWriteReceipt<EvidenceArtifactReference>,
  expected: EvidenceArtifactReference,
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

export interface PrepareSignedDisclosureInput {
  readonly requestId: ContributionRequestId;
  readonly intentFingerprint: Sha256Digest;
  readonly source: LoadedEvidenceSource;
  readonly route: VerifiedSignedUnchangedDecision;
  /**
   * Deviation from the plan's literal signature, matching Task 5's
   * `prepareExecutionDisclosure` addition: the given input carries no
   * repository binding at all, yet the route's allowed companion artifact
   * bytes must be loaded from somewhere before they can be staged.
   */
  readonly sourceRepositoryBindingId: string;
  readonly stagingRepositoryBindingId: string;
  readonly destinations: readonly ContributionDestination[];
}

/**
 * Prepare an already-signed Evaluation or Verification envelope unchanged.
 * The envelope bytes are staged byte-identical; only artifacts the
 * verified route explicitly allows are staged alongside it. Never resolves
 * or calls `EvidenceDeriver` -- signed records are immutable claims, not
 * Derivation subjects.
 */
export async function prepareSignedDisclosure(
  input: PrepareSignedDisclosureInput,
  repositories: RepositoryResolver,
  options?: ContributionOperationOptions,
): Promise<PreviewReadyPreparation> {
  if (
    input.source.reference.family !== "result-evaluation" &&
    input.source.reference.family !== "execution-verification"
  ) {
    throw new EvidenceContributionError("POLICY_INVALID");
  }
  const sourceRepository = await repositories.resolve(
    input.sourceRepositoryBindingId,
    toContributionCallOptions(options),
  );
  const stagingRepository = await repositories.resolve(
    input.stagingRepositoryBindingId,
    toContributionCallOptions(options),
  );

  const recordReceipt = await stagingRepository.putRecord(
    input.source.reference.family,
    input.source.bytes,
    options,
  );
  if (recordReceipt.reference.digest !== input.source.reference.digest) {
    throw new EvidenceContributionError("PORT_PROTOCOL_VIOLATION");
  }

  const artifacts: EvidenceArtifactReference[] = [];
  for (const allowed of input.route.allowedCompanionArtifacts) {
    const bytes = await loadExactArtifact(sourceRepository, allowed, options);
    const receipt = await stagingRepository.putArtifact(bytes, options);
    assertArtifactReceiptMatches(receipt, allowed);
    artifacts.push(receipt.reference);
  }

  const disclosure = createPreparedDisclosureManifest({
    requestId: input.requestId,
    intentFingerprint: input.intentFingerprint,
    source: input.source.reference,
    preparedRecord: recordReceipt.reference,
    artifacts,
    preparation: { kind: "signed-unchanged" },
    policyDecision: input.route.decision,
    destinations: input.destinations,
    unavailableArtifacts: [],
    risk: {
      irreversibility: "immutable-or-replicable",
      sourceCommitmentCorrelation: "none-declared",
    },
  });
  return { status: "preview-ready", disclosure };
}
