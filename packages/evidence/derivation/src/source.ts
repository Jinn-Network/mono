// SPDX-License-Identifier: Apache-2.0

import {
  checkArtifactIntegrity,
  recordDigest,
  validateExecutionEvidence,
  type ExecutionEvidenceDocument,
} from "@jinn-network/evidence-protocol";

import { copyBytes } from "./bytes.js";
import { EvidenceDerivationError } from "./errors.js";
import { snapshotInertData } from "./inert.js";
import type {
  DerivationRole,
  DeriveExecutionEvidenceInput,
} from "./types.js";

type Entity = ExecutionEvidenceDocument["@graph"][number];

export interface ValidatedDerivationSource {
  readonly document: ExecutionEvidenceDocument;
  readonly recordBytes: Uint8Array;
  readonly recordDigest: `sha256:${string}`;
  readonly entities: ReadonlyMap<string, Entity>;
  readonly roles: ReadonlyMap<string, DerivationRole>;
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
  readonly executionId: string;
}

export function snapshotDerivationInput(
  input: DeriveExecutionEvidenceInput,
): DeriveExecutionEvidenceInput {
  return snapshotInertData(input, "derivation input");
}

function references(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((entry) =>
    entry &&
    typeof entry === "object" &&
    typeof (entry as Record<string, unknown>)["@id"] === "string"
      ? [(entry as Record<string, string>)["@id"]]
      : [],
  );
}

function hasType(entity: Entity, type: string): boolean {
  const types = Array.isArray(entity["@type"])
    ? entity["@type"]
    : [entity["@type"]];
  return types.includes(type);
}

function rolesFor(
  document: ExecutionEvidenceDocument,
): { roles: Map<string, DerivationRole>; executionId: string } {
  const execution = document["@graph"].find(
    (entity) =>
      hasType(entity, "CreateAction") && hasType(entity, "prov:Activity"),
  );
  if (!execution) {
    throw new EvidenceDerivationError(
      "SOURCE_NONCONFORMING",
      "Conforming source has no primary Execution.",
    );
  }
  const roles = new Map<string, DerivationRole>();
  const objects = references(execution.object);
  const resultIds = references(execution.result);
  const instrumentIds = references(execution.instrument);
  const traceIds = references(execution.subjectOf);
  for (const id of objects) roles.set(id, "input");
  for (const entity of document["@graph"]) {
    if (
      objects.includes(entity["@id"]) &&
      hasType(entity, "prov:Plan")
    ) {
      roles.set(entity["@id"], "task");
    }
  }
  for (const id of resultIds) roles.set(id, "result");
  for (const id of instrumentIds) {
    roles.set(id, "runtime-specification");
    const runtime = document["@graph"].find((entity) => entity["@id"] === id);
    for (const component of references(runtime?.hasPart)) {
      roles.set(component, "runtime-component");
    }
  }
  for (const id of traceIds) roles.set(id, "native-trace");
  for (const entity of document["@graph"]) {
    if (
      roles.has(entity["@id"]) ||
      typeof entity.sha256 !== "string"
    ) {
      continue;
    }
    roles.set(
      entity["@id"],
      references(entity.about).includes(execution["@id"])
        ? "evidence"
        : "other",
    );
  }
  return { roles, executionId: execution["@id"] };
}

export function validateDerivationSource(
  input: DeriveExecutionEvidenceInput,
): ValidatedDerivationSource {
  input = snapshotDerivationInput(input);
  if (
    !input ||
    typeof input !== "object" ||
    input.sourceRecord?.reference?.family !== "execution-evidence" ||
    !(input.sourceRecord.bytes instanceof Uint8Array) ||
    !Array.isArray(input.sourceArtifacts)
  ) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Derivation input shape is invalid.",
    );
  }
  const recordBytes = copyBytes(input.sourceRecord.bytes);
  const actualRecordDigest = recordDigest(recordBytes);
  if (actualRecordDigest !== input.sourceRecord.reference.digest) {
    throw new EvidenceDerivationError(
      "SOURCE_DIGEST_MISMATCH",
      "Source record bytes do not match the declared digest.",
    );
  }
  const report = validateExecutionEvidence(recordBytes);
  if (!report.conforms || !report.value) {
    throw new EvidenceDerivationError(
      "SOURCE_NONCONFORMING",
      "Source record does not conform to Execution Evidence.",
      { details: report.diagnostics },
    );
  }
  const artifactBytes = new Map<string, Uint8Array>();
  for (const candidate of input.sourceArtifacts) {
    if (
      !candidate ||
      typeof candidate.entityId !== "string" ||
      !(candidate.bytes instanceof Uint8Array) ||
      artifactBytes.has(candidate.entityId)
    ) {
      throw new EvidenceDerivationError(
        "INVALID_DERIVATION_INPUT",
        "Source artifacts must have unique entity ids and exact bytes.",
      );
    }
    artifactBytes.set(candidate.entityId, copyBytes(candidate.bytes));
  }
  const integrity = checkArtifactIntegrity(report.value, artifactBytes);
  if (integrity.mismatched > 0) {
    throw new EvidenceDerivationError(
      "ARTIFACT_DIGEST_MISMATCH",
      "A supplied artifact does not match its graph digest.",
      {
        details: integrity.artifacts.filter(
          ({ status }) => status === "mismatch",
        ),
      },
    );
  }
  for (const entityId of artifactBytes.keys()) {
    const integrityEntry = integrity.artifacts.find(
      (entry) => entry.entityId === entityId,
    );
    if (!integrityEntry) {
      throw new EvidenceDerivationError(
        "INVALID_DERIVATION_INPUT",
        "A supplied artifact is not content-bound by the source graph.",
      );
    }
  }
  const document = structuredClone(report.value);
  const entities = new Map(
    document["@graph"].map((entity) => [entity["@id"], entity] as const),
  );
  const { roles, executionId } = rolesFor(document);
  return Object.freeze({
    document,
    recordBytes,
    recordDigest: actualRecordDigest,
    entities,
    roles,
    artifacts: artifactBytes,
    executionId,
  });
}
