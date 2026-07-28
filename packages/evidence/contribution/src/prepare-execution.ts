// SPDX-License-Identifier: Apache-2.0
import { recordDigest, validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import type {
  DerivationFinding,
  DerivationHoldReason,
} from "@jinn-network/evidence-derivation";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
  EvidenceRepository,
  RepositoryWriteReceipt,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";
import { createPreparedDisclosureManifest } from "./manifest.js";
import type { DerivationResolver, ReviewReferenceStore } from "./policy.js";
import type { LoadedEvidenceSource, RepositoryResolver } from "./source.js";
import type {
  ContributionDestination,
  ContributionOperationOptions,
  ContributionRequestId,
  ContributionSafeReasonCode,
  PreparationResult,
  PreparedUnavailableArtifact,
  VerifiedDeriveExecutionDecision,
} from "./types.js";
import { toContributionCallOptions } from "./types.js";

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

function assertArtifactReceiptMatches(
  receipt: RepositoryWriteReceipt<EvidenceArtifactReference>,
  expected: EvidenceArtifactReference,
): void {
  if (receipt.reference.digest !== expected.digest) {
    throw new EvidenceContributionError("PORT_PROTOCOL_VIOLATION");
  }
}

// Best-effort mapping from Derivation's open hold-reason vocabulary to
// Contribution's closed safe reason codes. Every code not explicitly
// listed here -- including every code observed so far -- maps to
// POLICY_WITHHELD; an upstream string is never copied into a stored or
// returned reason.
const DERIVATION_HOLD_REASON_MAP: Readonly<Record<string, ContributionSafeReasonCode>> = {};

function mapDerivationHoldReasons(
  reasons: readonly DerivationHoldReason[],
): readonly { readonly code: ContributionSafeReasonCode }[] {
  if (reasons.length === 0) return [{ code: "POLICY_WITHHELD" }];
  return reasons.map((reason) => ({
    code: DERIVATION_HOLD_REASON_MAP[reason.code] ?? "POLICY_WITHHELD",
  }));
}

export interface PrepareExecutionDisclosureInput {
  readonly requestId: ContributionRequestId;
  readonly intentFingerprint: Sha256Digest;
  readonly source: LoadedEvidenceSource;
  /**
   * Deviation from the plan's literal Task 5 signature: the given
   * `prepareExecutionDisclosure` input carries no repository binding at
   * all, yet this function must both load the route's private policy /
   * public implementation-descriptor bytes from a Repository and persist
   * them into the staging Repository before Derivation. Both binding IDs
   * are added here as the minimal fix; see the implementer's findings.
   */
  readonly sourceRepositoryBindingId: string;
  readonly stagingRepositoryBindingId: string;
  readonly route: VerifiedDeriveExecutionDecision;
  readonly destinations: readonly ContributionDestination[];
}

export interface PrepareExecutionDisclosureDependencies {
  readonly repositories: RepositoryResolver;
  readonly derivations: DerivationResolver;
  readonly reviews: ReviewReferenceStore;
}

/**
 * Prepare a private Execution Evidence source through Derivation under an
 * exact source-bound policy route. Loads the route's referenced policy and
 * public implementation-descriptor bytes (and every available source
 * artifact) from the source Repository, persists the policy/descriptor
 * bytes into the request's non-announcing staging Repository, dispatches
 * exact bytes to `EvidenceDeriver.derive`, and accepts only its four
 * defined outcomes. Never calls a Publication resolver.
 */
export async function prepareExecutionDisclosure(
  input: PrepareExecutionDisclosureInput,
  dependencies: PrepareExecutionDisclosureDependencies,
  options?: ContributionOperationOptions,
): Promise<PreparationResult> {
  if (input.source.reference.family !== "execution-evidence") {
    throw new EvidenceContributionError("POLICY_INVALID");
  }
  const sourceRepository = await dependencies.repositories.resolve(
    input.sourceRepositoryBindingId,
    toContributionCallOptions(options),
  );
  const stagingRepository = await dependencies.repositories.resolve(
    input.stagingRepositoryBindingId,
    toContributionCallOptions(options),
  );

  const policyBytes = await loadExactArtifact(
    sourceRepository,
    input.route.policyInput,
    options,
  );
  const implementationDescriptorBytes = await loadExactArtifact(
    sourceRepository,
    input.route.implementationDescriptor,
    options,
  );

  const unavailableArtifacts: PreparedUnavailableArtifact[] = [];
  const sourceArtifacts: { readonly entityId: string; readonly bytes: Uint8Array }[] = [];
  for (const declared of input.route.sourceArtifacts) {
    const bytes = await sourceRepository.getArtifact(declared.reference, options);
    if (bytes === null) {
      unavailableArtifacts.push({
        entityId: declared.entityId,
        reasonCode: "source-artifact-unavailable",
        sourceCommitment: declared.reference.digest,
      });
      continue;
    }
    const snapshot = Uint8Array.from(bytes);
    if (recordDigest(snapshot) !== declared.reference.digest) {
      throw new EvidenceContributionError("SOURCE_DIGEST_MISMATCH");
    }
    sourceArtifacts.push({ entityId: declared.entityId, bytes: snapshot });
  }

  const policyReceipt = await stagingRepository.putArtifact(policyBytes, options);
  assertArtifactReceiptMatches(policyReceipt, input.route.policyInput);
  const implementationReceipt = await stagingRepository.putArtifact(
    implementationDescriptorBytes,
    options,
  );
  assertArtifactReceiptMatches(implementationReceipt, input.route.implementationDescriptor);

  const deriver = await dependencies.derivations.resolve(
    {
      implementationDigest: input.route.implementationDigest,
      ...(input.route.configurationDigest !== undefined
        ? { configurationDigest: input.route.configurationDigest }
        : {}),
    },
    toContributionCallOptions(options),
  );

  const outcome = await deriver.derive(
    {
      sourceRecord: {
        reference: { family: "execution-evidence", digest: input.source.reference.digest },
        bytes: input.source.bytes,
      },
      sourceArtifacts,
      policyBytes,
      scrubber: {
        agentId: input.route.scrubberAgentId,
        implementationDescriptorBytes,
      },
      completedAt: input.route.completedAt,
    },
    options,
  );

  if (outcome.status === "review-required") {
    const findings: readonly DerivationFinding[] = outcome.findings;
    const { reviewReference } = await dependencies.reviews.retain(
      { requestId: input.requestId, findings },
      toContributionCallOptions(options),
    );
    return { status: "review-required", reviewReference };
  }
  if (outcome.status === "withheld") {
    return { status: "withheld", reasons: mapDerivationHoldReasons(outcome.reasons) };
  }

  const report = validateExecutionEvidence(outcome.record.bytes);
  if (!report.conforms || report.recordDigest !== outcome.record.reference.digest) {
    throw new EvidenceContributionError("SOURCE_NONCONFORMING");
  }
  for (const artifact of outcome.artifacts) {
    if (recordDigest(artifact.bytes) !== artifact.digest) {
      throw new EvidenceContributionError("PORT_PROTOCOL_VIOLATION");
    }
  }

  const preparedRecordReceipt = await stagingRepository.putRecord(
    "execution-evidence",
    outcome.record.bytes,
    options,
  );
  if (preparedRecordReceipt.reference.digest !== outcome.record.reference.digest) {
    throw new EvidenceContributionError("PORT_PROTOCOL_VIOLATION");
  }
  const stagedArtifacts: EvidenceArtifactReference[] = [];
  for (const artifact of outcome.artifacts) {
    const receipt = await stagingRepository.putArtifact(artifact.bytes, options);
    if (receipt.reference.digest !== artifact.digest) {
      throw new EvidenceContributionError("PORT_PROTOCOL_VIOLATION");
    }
    stagedArtifacts.push(receipt.reference);
  }

  const preparedRecord: EvidenceRecordReference = preparedRecordReceipt.reference;
  const commonManifestInput = {
    requestId: input.requestId,
    intentFingerprint: input.intentFingerprint,
    source: input.source.reference,
    preparedRecord,
    artifacts: stagedArtifacts,
    policyDecision: input.route.decision,
    destinations: input.destinations,
    bindingImpact: outcome.bindingImpact,
    unavailableArtifacts,
    risk: input.route.risk,
  };

  if (outcome.status === "publishable-unchanged") {
    const disclosure = createPreparedDisclosureManifest({
      ...commonManifestInput,
      preparation: {
        kind: "publishable-unchanged",
        policyInput: policyReceipt.reference,
        implementationDescriptor: implementationReceipt.reference,
        policyDigest: input.route.policyDigest,
        implementationDigest: input.route.implementationDigest,
        ...(input.route.configurationDigest !== undefined
          ? { configurationDigest: input.route.configurationDigest }
          : {}),
      },
    });
    return { status: "preview-ready", disclosure };
  }

  const receiptBytes = outcome.receipt.bytes;
  const receiptWrite = await stagingRepository.putArtifact(receiptBytes, options);
  if (receiptWrite.reference.digest !== outcome.receipt.digest) {
    throw new EvidenceContributionError("PORT_PROTOCOL_VIOLATION");
  }
  const disclosure = createPreparedDisclosureManifest({
    ...commonManifestInput,
    preparation: {
      kind: "derived",
      derivationReceipt: receiptWrite.reference,
      policyInput: policyReceipt.reference,
      implementationDescriptor: implementationReceipt.reference,
      policyDigest: input.route.policyDigest,
      implementationDigest: input.route.implementationDigest,
      ...(input.route.configurationDigest !== undefined
        ? { configurationDigest: input.route.configurationDigest }
        : {}),
    },
  });
  return { status: "preview-ready", disclosure };
}
