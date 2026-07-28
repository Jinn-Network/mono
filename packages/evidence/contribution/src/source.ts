// SPDX-License-Identifier: Apache-2.0
import {
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";
import type {
  ContributionCallOptions,
  ContributionOperationOptions,
  EvidenceSourceSelection,
} from "./types.js";
import { toContributionCallOptions } from "./types.js";

export interface RepositoryResolver {
  resolve(
    bindingId: string,
    options?: ContributionCallOptions,
  ): Promise<EvidenceRepository>;
}

export interface LoadedEvidenceSource {
  readonly reference: EvidenceRecordReference;
  readonly bytes: Uint8Array;
}

function validateByFamily(
  family: EvidenceRecordReference["family"],
  bytes: Uint8Array,
): { readonly conforms: boolean; readonly recordDigest: string } {
  switch (family) {
    case "execution-evidence":
      return validateExecutionEvidence(bytes);
    case "result-evaluation":
      return validateResultEvaluation(bytes);
    case "execution-verification":
      return validateExecutionVerification(bytes);
  }
}

/**
 * Load exact bytes for one primary Evidence source, verify they hash to
 * the requested digest, and validate them against their declared record
 * family's Protocol conformance rules. Fails closed without modifying the
 * private Repository. Diagnostics are never attached to the thrown error
 * -- callers see only the closed `SOURCE_NONCONFORMING` code.
 */
export async function loadAndValidateEvidenceSource(
  selection: EvidenceSourceSelection,
  repositories: RepositoryResolver,
  options?: ContributionOperationOptions,
): Promise<LoadedEvidenceSource> {
  const repository = await repositories.resolve(
    selection.repositoryBindingId,
    toContributionCallOptions(options),
  );
  const bytes = await repository.getRecord(selection.record, options);
  if (bytes === null) {
    throw new EvidenceContributionError("SOURCE_NOT_FOUND");
  }
  const snapshot = Uint8Array.from(bytes);
  const report = validateByFamily(selection.record.family, snapshot);
  if (report.recordDigest !== selection.record.digest) {
    throw new EvidenceContributionError("SOURCE_DIGEST_MISMATCH");
  }
  if (!report.conforms) {
    throw new EvidenceContributionError("SOURCE_NONCONFORMING");
  }
  return {
    reference: {
      family: selection.record.family,
      digest: selection.record.digest,
    },
    bytes: snapshot,
  };
}
