// SPDX-License-Identifier: Apache-2.0

import type {
  EvidenceArtifactReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  type TrajectoryRecord,
  parseTrajectory,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
} from "@jinn-network/evidence-trajectory";

import { PluginRuntimeError } from "../errors.js";

const SHA256_REFERENCE = /^sha256:[0-9a-f]{64}$/u;

function asArray(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Reads the trajectory record's digest out of a sealed execution record.
 *
 * The link is an `identifier` PropertyValue on the native-trace entity, which the recorder
 * emits from `ArtifactCapture.identifiers`
 * (`packages/evidence/execution-recorder/src/graph.ts:402-404`). It lives there rather than in
 * the catalog because `EVIDENCE_RECORD_FAMILIES` is closed
 * (`packages/evidence/repository/src/types.ts:1-5`) and a trajectory is therefore stored as a
 * repository artifact, which the catalog does not project.
 *
 * Returns `null` for any record that does not carry the link, including unreadable bytes —
 * a missing link is an ordinary state (every record written by another producer lacks one),
 * not an error.
 */
export function trajectoryReferenceFromRecordBytes(
  bytes: Uint8Array,
): EvidenceArtifactReference | null {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const graph = (document as { readonly "@graph"?: unknown })?.["@graph"];
  if (!Array.isArray(graph)) return null;

  for (const entity of graph) {
    if (entity === null || typeof entity !== "object") continue;
    for (const identifier of asArray((entity as Record<string, unknown>).identifier)) {
      if (identifier === null || typeof identifier !== "object") continue;
      const candidate = identifier as Record<string, unknown>;
      if (candidate.propertyID !== TRAJECTORY_RECORD_IDENTIFIER_PROPERTY) continue;
      const value = candidate.value;
      if (typeof value === "string" && SHA256_REFERENCE.test(value)) {
        return { digest: value as `sha256:${string}` };
      }
    }
  }
  return null;
}

/** Fetches and parses the sealed trajectory artifact under C1's exact-bytes discipline. */
export async function loadTrajectoryRecord(
  repository: EvidenceRepository,
  reference: EvidenceArtifactReference,
  options?: { readonly signal?: AbortSignal },
): Promise<TrajectoryRecord> {
  const bytes = await repository.getArtifact(reference, options);
  if (bytes === null) {
    throw new PluginRuntimeError(
      "capture-trajectory-missing",
      `The trajectory record ${reference.digest} is not present in this archive.`,
    );
  }
  return parseTrajectory(bytes);
}
