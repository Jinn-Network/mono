import { EvidenceRepositoryError } from "@jinn-network/evidence-repository";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";

import type {
  EvidenceLocationPolicy,
  EvidenceRecordLocator,
  EvidenceRecordReference,
  EvidenceRetrievalFailure,
  RetrievalLocationAttempt,
  RetrievalLocationObservation,
  RetrievalLocationHint,
  RetrievalWarning,
  ValidatedRecord,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";
import { createEvidenceRetrievalFailure } from "./errors.js";
import type { OperationContext } from "./operation.js";
import { validateCanonicalRecord } from "./validation.js";

export interface ResolvedValidatedRecord {
  readonly reference: EvidenceRecordReference;
  readonly canonicalBytes: Uint8Array;
  readonly validatedRecord: ValidatedRecord;
  readonly availability: readonly RetrievalLocationObservation[];
  readonly selectedLocation: RetrievalLocationObservation;
  readonly repository: EvidenceRepository;
  readonly allowedLocationAttempts: readonly RetrievalLocationAttempt[];
  readonly warnings: readonly RetrievalWarning[];
  readonly failures: readonly EvidenceRetrievalFailure[];
}

export type RecordResolutionOutcome =
  | {
      readonly ok: true;
      readonly record: ResolvedValidatedRecord;
    }
  | {
      readonly ok: false;
      readonly failure: EvidenceRetrievalFailure;
      readonly availability: readonly RetrievalLocationObservation[];
      readonly failures: readonly EvidenceRetrievalFailure[];
    };

export interface ResolveValidatedRecordInput {
  readonly reference: EvidenceRecordReference;
  readonly hints: readonly RetrievalLocationHint[];
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly context: OperationContext;
}

function failureToWarning(failure: EvidenceRetrievalFailure): RetrievalWarning {
  return { code: failure.code, message: failure.message };
}

function failureForUnresolved(
  reference: EvidenceRecordReference,
  repositoryId: string,
): EvidenceRetrievalFailure {
  return createEvidenceRetrievalFailure({
    code: "REPOSITORY_UNRESOLVED",
    stage: "location",
    message: "The repository resolver did not resolve this repository.",
    reference,
    repositoryId,
    retryable: true,
  });
}

function failureForUnavailable(
  reference: EvidenceRecordReference,
  repositoryId: string,
): EvidenceRetrievalFailure {
  return createEvidenceRetrievalFailure({
    code: "WITHDRAWN_OR_UNAVAILABLE",
    stage: "location",
    message: "The repository did not have this record.",
    reference,
    repositoryId,
    retryable: true,
  });
}

function classifyRepositoryError(
  error: unknown,
  reference: EvidenceRecordReference,
  repositoryId: string,
  context: OperationContext,
): EvidenceRetrievalFailure {
  if (error instanceof EvidenceRepositoryError) {
    switch (error.code) {
      case "ACCESS_DENIED":
        return createEvidenceRetrievalFailure({
          code: "ACCESS_DENIED",
          stage: "location",
          message: "The repository denied access to this record.",
          reference,
          repositoryId,
          retryable: false,
        });
      case "CONTENT_TOO_LARGE":
        return createEvidenceRetrievalFailure({
          code: "RECORD_TOO_LARGE",
          stage: "record",
          message: "The repository reported the record exceeds its size limit.",
          reference,
          repositoryId,
          retryable: false,
        });
      case "OPERATION_ABORTED":
        return context.timedOut()
          ? createEvidenceRetrievalFailure({
              code: "TIMED_OUT",
              stage: "location",
              message: "Fetching this record exceeded the operation deadline.",
              reference,
              repositoryId,
              retryable: true,
            })
          : createEvidenceRetrievalFailure({
              code: "OPERATION_ABORTED",
              stage: "location",
              message: "Fetching this record was aborted by the caller.",
              reference,
              repositoryId,
              retryable: false,
            });
      case "DEPENDENCY_UNAVAILABLE":
      case "IO_FAILURE":
        return createEvidenceRetrievalFailure({
          code: "WITHDRAWN_OR_UNAVAILABLE",
          stage: "location",
          message: "The repository was unavailable for this record.",
          reference,
          repositoryId,
          retryable: true,
        });
      case "CONTENT_CORRUPT":
        return createEvidenceRetrievalFailure({
          code: "RECORD_DIGEST_MISMATCH",
          stage: "record",
          message: "The repository reported corrupt content for this record.",
          reference,
          repositoryId,
          retryable: false,
        });
      default:
        break;
    }
  }
  return createEvidenceRetrievalFailure({
    code: "WITHDRAWN_OR_UNAVAILABLE",
    stage: "location",
    message: "The repository reported an unclassified error for this record.",
    reference,
    repositoryId,
    retryable: true,
  });
}

function classifyLocatorError(
  reference: EvidenceRecordReference,
  context: OperationContext,
): EvidenceRetrievalFailure {
  if (context.signal.aborted) {
    return context.timedOut()
      ? createEvidenceRetrievalFailure({
          code: "TIMED_OUT",
          stage: "location",
          message: "Locating this record exceeded the operation deadline.",
          reference,
          retryable: true,
        })
      : createEvidenceRetrievalFailure({
          code: "OPERATION_ABORTED",
          stage: "location",
          message: "Locating this record was aborted by the caller.",
          reference,
          retryable: false,
        });
  }
  return createEvidenceRetrievalFailure({
    code: "WITHDRAWN_OR_UNAVAILABLE",
    stage: "location",
    message: "The record locator failed to report locations for this record.",
    reference,
    retryable: true,
  });
}

export async function resolveValidatedRecord(
  input: ResolveValidatedRecordInput,
): Promise<RecordResolutionOutcome> {
  const {
    reference,
    hints,
    locator,
    locationPolicy,
    repositoryResolver,
    context,
  } = input;

  let availability: readonly RetrievalLocationObservation[];
  try {
    availability = await locator.locate(reference, hints, {
      signal: context.signal,
      timeoutMs: context.remainingMs(),
      maximumLocations: context.maxLocationObservations,
    });
  } catch {
    const failure = classifyLocatorError(reference, context);
    return { ok: false, failure, availability: [], failures: [failure] };
  }

  if (availability.length > context.maxLocationObservations) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Record locator exceeded the maximum location observations.",
    );
  }

  let selected: readonly RetrievalLocationAttempt[];
  try {
    selected = locationPolicy.select(reference, availability);
  } catch {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Location policy threw while selecting an attempt order.",
    );
  }
  if (
    selected.some(
      ({ observation, repositoryId }) =>
        observation.status !== "available"
        || observation.repositoryId !== repositoryId
        || !availability.includes(observation),
    )
  ) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Location policy returned an observation outside its bounded input.",
    );
  }

  const attempts = selected.slice(0, context.maxLocationAttempts);

  if (attempts.length === 0) {
    const allWithdrawn =
      availability.length > 0
      && availability.every((observation) => observation.status === "withdrawn");
    const failure = createEvidenceRetrievalFailure({
      code: allWithdrawn ? "WITHDRAWN_OR_UNAVAILABLE" : "NO_LOCATION",
      stage: "location",
      message: allWithdrawn
        ? "Every observed location for this record has been withdrawn."
        : "No allowed location was observed for this record.",
      reference,
      retryable: allWithdrawn,
    });
    return { ok: false, failure, availability, failures: [failure] };
  }

  const failures: EvidenceRetrievalFailure[] = [];

  for (const attempt of attempts) {
    try {
      const repository = await repositoryResolver.resolve(attempt.repositoryId, {
        signal: context.signal,
      });
      if (!repository) {
        failures.push(failureForUnresolved(reference, attempt.repositoryId));
        continue;
      }
      const bytes = await repository.getRecord(reference, {
        signal: context.signal,
      });
      if (!bytes) {
        failures.push(failureForUnavailable(reference, attempt.repositoryId));
        continue;
      }
      if (!context.consumeRecordBytes(bytes.byteLength)) {
        failures.push(
          createEvidenceRetrievalFailure({
            code: "BYTE_BUDGET_EXCEEDED",
            stage: "record",
            message: "The operation record-byte budget was exhausted.",
            reference,
            repositoryId: attempt.repositoryId,
          }),
        );
        break;
      }
      const effectiveMaximum = Math.min(
        context.maxRecordBytes,
        repository.capabilities.maxObjectBytes ?? context.maxRecordBytes,
      );
      const validation = validateCanonicalRecord(
        reference,
        bytes,
        effectiveMaximum,
      );
      if (!validation.ok) {
        failures.push({
          ...validation.failure,
          repositoryId: attempt.repositoryId,
        });
        continue;
      }
      return {
        ok: true,
        record: {
          reference,
          canonicalBytes: validation.canonicalBytes,
          validatedRecord: validation.validatedRecord,
          availability,
          selectedLocation: attempt.observation,
          repository,
          allowedLocationAttempts: attempts,
          warnings: failures.map(failureToWarning),
          failures,
        },
      };
    } catch (error) {
      failures.push(
        classifyRepositoryError(error, reference, attempt.repositoryId, context),
      );
      if (context.signal.aborted) break;
    }
  }

  const lastFailure = failures[failures.length - 1]!;
  return { ok: false, failure: lastFailure, availability, failures };
}
