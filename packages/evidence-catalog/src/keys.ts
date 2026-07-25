// SPDX-License-Identifier: MIT
import type {
  CatalogRecordProjection,
  EvidenceRecordReference,
  RecordLocationObservation,
} from "./types.js";

export function recordKey(reference: EvidenceRecordReference): string {
  return `${reference.family}\0${reference.digest}`;
}

export function observationKey(
  observation: Pick<RecordLocationObservation, "sourceId" | "announcementId">,
): string {
  return `${observation.sourceId}\0${observation.announcementId}`;
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalized);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
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
