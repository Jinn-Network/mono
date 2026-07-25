// SPDX-License-Identifier: MIT
import { recordDigest, type ConformanceDiagnostic } from "@jinn-network/evidence-protocol";
import type {
  CatalogOperationOptions,
  EvidenceCatalogWriter,
  EvidenceRecordAnnouncement,
  EvidenceRepositoryResolver,
} from "@jinn-network/evidence-catalog";
import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";

import {
  assertEvidenceIndexerOperationActive,
  EvidenceIndexerError,
} from "./errors.js";
import { validateAndProjectEvidenceRecord } from "./project-record.js";

export type EvidenceIndexingResult =
  | {
      readonly status: "indexed";
      readonly reference: EvidenceRecordReference;
      readonly projectionStatus: "created" | "existing";
      readonly locationStatus: "created" | "existing";
    }
  | {
      readonly status: "rejected";
      readonly reference: EvidenceRecordReference;
      readonly diagnostics: readonly ConformanceDiagnostic[];
    }
  | {
      readonly status: "withdrawn";
      readonly locationStatus: "withdrawn" | "absent" | "existing";
    };

export interface EvidenceIndexer {
  index(
    announcement: EvidenceRecordAnnouncement,
    options?: CatalogOperationOptions,
  ): Promise<EvidenceIndexingResult>;
}

export interface CreateEvidenceIndexerOptions {
  readonly repositories: EvidenceRepositoryResolver;
  readonly catalog: EvidenceCatalogWriter;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function nonEmpty(value: unknown, role: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EvidenceIndexerError(
      "ANNOUNCEMENT_INVALID",
      `${role} must be a non-empty string.`,
    );
  }
}

function invalid(message: string): never {
  throw new EvidenceIndexerError("ANNOUNCEMENT_INVALID", message);
}

function plainDataObject(
  value: unknown,
  role: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${role} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${role} must have a safe plain-object prototype.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid(`${role} must not contain symbol properties.`);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${role}.${key} must be an enumerable data property.`);
    }
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  role: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    invalid(`${role} contains unsupported field ${unexpected.sort()[0]}.`);
  }
}

function finiteJson(
  value: unknown,
  role: string,
  ancestors = new WeakSet<object>(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${role} must contain finite numbers.`);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || ancestors.has(value)) {
      invalid(`${role} must contain safe acyclic arrays.`);
    }
    ancestors.add(value);
    if (
      Reflect.ownKeys(value).some((key) =>
        typeof key !== "string" ||
        (
          key !== "length" &&
          (
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= value.length ||
            Number(key) > 0xffff_fffe
          )
        ))
    ) {
      invalid(`${role} must not contain non-index array properties.`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        invalid(`${role} must contain dense enumerable data-property arrays.`);
      }
      finiteJson(descriptor.value, `${role}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (typeof value === "object") {
    plainDataObject(value, role);
    if (ancestors.has(value)) invalid(`${role} must not contain cycles.`);
    ancestors.add(value);
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      finiteJson(descriptor.value, `${role}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  invalid(`${role} must contain only JSON values.`);
}

function validateAnnouncement(
  value: unknown,
): asserts value is EvidenceRecordAnnouncement {
  plainDataObject(value, "announcement");
  if (value.kind !== "available" && value.kind !== "withdrawn") {
    invalid("announcement kind must be available or withdrawn.");
  }
  nonEmpty(value.sourceId, "sourceId");
  nonEmpty(value.announcementId, "announcementId");
  if (value.kind === "withdrawn") {
    exactKeys(
      value,
      ["kind", "sourceId", "announcementId", "retractsAnnouncementId"],
      "announcement",
    );
    nonEmpty(value.retractsAnnouncementId, "retractsAnnouncementId");
    return;
  }
  exactKeys(
    value,
    [
      "kind",
      "sourceId",
      "announcementId",
      "repositoryId",
      "reference",
      "publishedLocation",
    ],
    "announcement",
  );
  nonEmpty(value.repositoryId, "repositoryId");
  plainDataObject(value.reference, "reference");
  exactKeys(value.reference, ["family", "digest"], "reference");
  if (
    ![
      "execution-evidence",
      "result-evaluation",
      "execution-verification",
    ].includes(value.reference.family as string) ||
    typeof value.reference.digest !== "string" ||
    !DIGEST.test(value.reference.digest)
  ) {
    invalid("reference must identify a supported family and canonical digest.");
  }
  if (value.publishedLocation !== undefined) {
    plainDataObject(value.publishedLocation, "publishedLocation");
    exactKeys(
      value.publishedLocation,
      ["bindingProfile", "locator"],
      "publishedLocation",
    );
    nonEmpty(value.publishedLocation.bindingProfile, "bindingProfile");
    try {
      if (new URL(value.publishedLocation.bindingProfile).protocol.length === 0) {
        invalid("bindingProfile must be an absolute identifier.");
      }
    } catch {
      invalid("bindingProfile must be an absolute identifier.");
    }
    plainDataObject(value.publishedLocation.locator, "locator");
    finiteJson(value.publishedLocation.locator, "locator");
  }
}

export function snapshotEvidenceRecordAnnouncement(
  value: unknown,
): EvidenceRecordAnnouncement {
  validateAnnouncement(value);
  return structuredClone(value);
}

export function createEvidenceIndexer(
  options: CreateEvidenceIndexerOptions,
): EvidenceIndexer {
  return {
    async index(announcement, operationOptions) {
      assertEvidenceIndexerOperationActive(operationOptions);
      const accepted = snapshotEvidenceRecordAnnouncement(announcement);

      if (accepted.kind === "withdrawn") {
        const receipt =
          await options.catalog.withdrawRecordLocationObservation(
            {
              sourceId: accepted.sourceId,
              announcementId: accepted.announcementId,
              retractsAnnouncementId: accepted.retractsAnnouncementId,
            },
            operationOptions,
          );
        assertEvidenceIndexerOperationActive(operationOptions);
        if (receipt.status === "created") {
          throw new EvidenceIndexerError(
            "VALIDATED_RECORD_INCONSISTENT",
            "Catalog returned an invalid withdrawal status.",
          );
        }
        return {
          status: "withdrawn",
          locationStatus: receipt.status,
        };
      }

      const repository = await options.repositories.resolve(
        accepted.repositoryId,
        operationOptions,
      );
      assertEvidenceIndexerOperationActive(operationOptions);
      if (repository === null) {
        throw new EvidenceIndexerError(
          "REPOSITORY_NOT_CONFIGURED",
          `Repository ${accepted.repositoryId} is not configured.`,
        );
      }

      const bytes = await repository.getRecord(
        accepted.reference,
        operationOptions,
      );
      assertEvidenceIndexerOperationActive(operationOptions);
      if (bytes === null) {
        throw new EvidenceIndexerError(
          "RECORD_UNAVAILABLE",
          "The announced record is unavailable from the resolved repository.",
        );
      }
      if (recordDigest(bytes) !== accepted.reference.digest) {
        throw new EvidenceIndexerError(
          "REFERENCE_MISMATCH",
          "Retrieved record bytes do not match the announced reference.",
        );
      }

      const validation = validateAndProjectEvidenceRecord(
        accepted.reference,
        bytes,
      );
      if (!validation.conforms) {
        return {
          status: "rejected",
          reference: accepted.reference,
          diagnostics: validation.diagnostics,
        };
      }

      const projection = await options.catalog.putRecordProjection(
        validation.projection,
        operationOptions,
      );
      assertEvidenceIndexerOperationActive(operationOptions);
      const location = await options.catalog.observeRecordLocation(
        accepted.reference,
        {
          sourceId: accepted.sourceId,
          announcementId: accepted.announcementId,
          repositoryId: accepted.repositoryId,
          ...(accepted.publishedLocation === undefined
            ? {}
            : { publishedLocation: accepted.publishedLocation }),
        },
        operationOptions,
      );
      assertEvidenceIndexerOperationActive(operationOptions);
      if (location.status !== "created" && location.status !== "existing") {
        throw new EvidenceIndexerError(
          "VALIDATED_RECORD_INCONSISTENT",
          "Catalog returned an invalid availability observation status.",
        );
      }
      return {
        status: "indexed",
        reference: accepted.reference,
        projectionStatus: projection.status,
        locationStatus: location.status,
      };
    },
  };
}
