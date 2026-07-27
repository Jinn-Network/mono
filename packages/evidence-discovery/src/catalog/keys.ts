// SPDX-License-Identifier: MIT
import type {
  CatalogRecordProjection,
  EvidenceRecordReference,
  RecordLocationObservation,
} from "./types.js";

export function recordKey(reference: EvidenceRecordReference): string {
  return deterministicJson([reference.family, reference.digest]);
}

export function observationKey(
  observation: Pick<RecordLocationObservation, "sourceId" | "announcementId">,
): string {
  return deterministicJson([observation.sourceId, observation.announcementId]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalized);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, child]) => [key, normalized(child)]),
    );
  }
  return value;
}

export function deterministicJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function projectionKey(projection: CatalogRecordProjection): string {
  return deterministicJson(projection);
}
