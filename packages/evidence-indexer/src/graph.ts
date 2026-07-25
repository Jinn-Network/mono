// SPDX-License-Identifier: MIT
import type { ExecutionEvidenceDocument } from "@jinn-network/evidence-protocol";
import type {
  CatalogArtifactProjection,
  DeclaredEntityOccurrence,
  DeclaredRelationshipOccurrence,
  Sha256Digest,
} from "@jinn-network/evidence-catalog";

import { EvidenceIndexerError } from "./errors.js";

export type ExecutionGraphEntity =
  ExecutionEvidenceDocument["@graph"][number];

const INCONSISTENT_GRAPH_MESSAGE =
  "Validated graph is missing a required primary relationship.";

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inconsistentGraph(): never {
  throw new EvidenceIndexerError(
    "VALIDATED_RECORD_INCONSISTENT",
    INCONSISTENT_GRAPH_MESSAGE,
  );
}

function values(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isReference(value: unknown): value is { readonly "@id": string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly "@id"?: unknown })["@id"] === "string"
  );
}

export function types(entity: ExecutionGraphEntity): readonly string[] {
  const declared = entity["@type"];
  return Array.isArray(declared) ? [...declared] : [declared];
}

export function hasType(
  entity: ExecutionGraphEntity,
  type: string,
): boolean {
  return types(entity).includes(type);
}

export function references(
  entity: ExecutionGraphEntity,
  property: string,
): readonly string[] {
  return values(entity[property])
    .filter(isReference)
    .map((reference) => reference["@id"]);
}

export function requiredEntity(
  byId: ReadonlyMap<string, ExecutionGraphEntity>,
  id: string,
  _role: string,
): ExecutionGraphEntity {
  return byId.get(id) ?? inconsistentGraph();
}

export function requiredSingleReference(
  entity: ExecutionGraphEntity,
  property: string,
  _role: string,
): string {
  const declared = references(entity, property);
  if (declared.length !== 1) inconsistentGraph();
  return declared[0]!;
}

export function artifactProjection(
  entity: ExecutionGraphEntity,
): CatalogArtifactProjection {
  if (typeof entity.sha256 !== "string") inconsistentGraph();

  return {
    entityId: entity["@id"],
    digest: `sha256:${entity.sha256}` as Sha256Digest,
    ...(typeof entity.name === "string" ? { name: entity.name } : {}),
    ...(typeof entity.encodingFormat === "string"
      ? { mediaType: entity.encodingFormat }
      : {}),
  };
}

export function createEntityMap(
  document: ExecutionEvidenceDocument,
): ReadonlyMap<string, ExecutionGraphEntity> {
  return new Map(document["@graph"].map((entity) => [entity["@id"], entity]));
}

export interface DeclaredGraphProjection {
  readonly declaredEntities: readonly DeclaredEntityOccurrence[];
  readonly declaredRelationships: readonly DeclaredRelationshipOccurrence[];
}

export function projectDeclaredGraph(
  document: ExecutionEvidenceDocument,
  predicates: readonly string[],
  byId: ReadonlyMap<string, ExecutionGraphEntity> = createEntityMap(document),
): DeclaredGraphProjection {
  const entityIds = new Set(["ro-crate-metadata.json", "./"]);
  const declaredRelationships: DeclaredRelationshipOccurrence[] = [];

  for (const entity of document["@graph"]) {
    for (const predicate of predicates) {
      for (const targetEntityId of references(entity, predicate)) {
        entityIds.add(entity["@id"]);
        if (byId.has(targetEntityId)) entityIds.add(targetEntityId);
        declaredRelationships.push({
          sourceEntityId: entity["@id"],
          predicate,
          targetEntityId,
        });
      }
    }
  }

  declaredRelationships.sort(
    (left, right) =>
      compareCodeUnits(left.sourceEntityId, right.sourceEntityId) ||
      compareCodeUnits(left.predicate, right.predicate) ||
      compareCodeUnits(left.targetEntityId, right.targetEntityId),
  );

  const declaredEntities = [...entityIds]
    .map((entityId) => requiredEntity(byId, entityId, "declared entity"))
    .map(
      (entity): DeclaredEntityOccurrence => ({
        entityId: entity["@id"],
        types: [...types(entity)].sort(compareCodeUnits),
        ...(typeof entity.name === "string" ? { name: entity.name } : {}),
      }),
    )
    .sort((left, right) => compareCodeUnits(left.entityId, right.entityId));

  return {
    declaredEntities,
    declaredRelationships,
  };
}
