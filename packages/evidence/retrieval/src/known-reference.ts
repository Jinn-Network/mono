import { parseEvidenceRecordReference } from "@jinn-network/evidence-repository";
import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";

import {
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type RetrievalHardLimits,
  type RetrievalTelemetry,
  type RetrieveEvidenceInput,
  type RetrieveEvidenceOutcome,
  type RetrievalOperationOptions,
} from "./contracts.js";
import { hydrateArtifacts } from "./artifacts.js";
import { EvidenceRetrievalError } from "./errors.js";
import { assertBoundedJson, createOperationContext } from "./operation.js";
import { resolveValidatedRecord } from "./resolution.js";
import { createTelemetrySession } from "./telemetry.js";

export interface KnownReferenceDependencies {
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly hardLimits: RetrievalHardLimits;
  readonly telemetry?: RetrievalTelemetry;
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
  const telemetry = createTelemetrySession(
    dependencies.telemetry,
    context,
    "retrieve",
  );
  await telemetry.emit({ stage: "started" });
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
      await telemetry.emit({
        stage: "record",
        failureCode: outcome.failure.code,
      });
      await telemetry.emit({
        stage: "completed",
        resultCount: 0,
        failureCode: outcome.failure.code,
      });
      return { status: "failed", failure: outcome.failure };
    }
    const record = outcome.record;
    await telemetry.emit({
      stage: "record",
      ...(record.selectedLocation.publishedLocation === undefined
        ? {}
        : { bindingProfile: record.selectedLocation.publishedLocation.bindingProfile }),
      bytes: record.canonicalBytes.byteLength,
    });
    const hydration = await hydrateArtifacts({
      record,
      request: input.artifacts,
      repositoryResolver: dependencies.repositoryResolver,
      context,
    });
    await telemetry.emit({
      stage: "artifact",
      bytes: hydration.results.reduce(
        (sum, artifact) => sum + (artifact.bytes?.byteLength ?? 0),
        0,
      ),
      ...(hydration.completeness === "artifact-incomplete"
        ? { failureCode: "REQUIRED_ARTIFACT_UNAVAILABLE" as const }
        : {}),
    });
    await telemetry.emit({ stage: "completed", resultCount: 1 });
    return {
      status: "validated",
      result: {
        reference,
        canonicalBytes: record.canonicalBytes,
        validatedRecord: record.validatedRecord,
        discoveryProvenance: [],
        availability: record.availability,
        selectedLocation: record.selectedLocation,
        artifacts: hydration.results,
        completeness: hydration.completeness,
        warnings: [...record.warnings, ...hydration.warnings],
      },
    };
  } finally {
    context.dispose();
  }
}
