import { parseEvidenceRecordReference } from "@jinn-network/evidence-repository";
import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";

import {
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type RetrievalHardLimits,
  type RetrieveEvidenceInput,
  type RetrieveEvidenceOutcome,
  type RetrievalOperationOptions,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";
import { assertBoundedJson, createOperationContext } from "./operation.js";
import { resolveValidatedRecord } from "./resolution.js";

export interface KnownReferenceDependencies {
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly hardLimits: RetrievalHardLimits;
}

export async function retrieveKnownReference(
  dependencies: KnownReferenceDependencies,
  input: RetrieveEvidenceInput,
  operationOptions?: RetrievalOperationOptions,
): Promise<RetrieveEvidenceOutcome> {
  let reference;
  try {
    reference = parseEvidenceRecordReference(input.reference);
  } catch {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "reference must be a canonical Evidence record reference.",
    );
  }
  const context = createOperationContext(
    dependencies.hardLimits,
    operationOptions,
  );
  try {
    const hints = input.locationHints ?? [];
    if (hints.length > context.maxLocationObservations) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "locationHints exceeds the host observation limit.",
      );
    }
    assertBoundedJson(
      hints,
      context.maxProviderMetadataBytes,
      "locationHints",
    );
    const outcome = await resolveValidatedRecord({
      reference,
      hints,
      locator: dependencies.locator,
      locationPolicy: dependencies.locationPolicy,
      repositoryResolver: dependencies.repositoryResolver,
      context,
    });
    if (!outcome.ok) {
      return { status: "failed", failure: outcome.failure };
    }
    const record = outcome.record;
    return {
      status: "validated",
      result: {
        reference,
        canonicalBytes: record.canonicalBytes,
        validatedRecord: record.validatedRecord,
        discoveryProvenance: [],
        availability: record.availability,
        selectedLocation: record.selectedLocation,
        artifacts: [],
        completeness: "complete",
        warnings: record.warnings,
      },
    };
  } finally {
    context.dispose();
  }
}
