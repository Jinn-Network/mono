// SPDX-License-Identifier: Apache-2.0

import {
  recordDigest,
  validateExecutionEvidence,
  type ExecutionEvidenceDocument,
} from "@jinn-network/evidence-protocol";

import type {
  ArtifactTransformationSet,
} from "./artifact-transform.js";
import { copyBytes } from "./bytes.js";
import { EvidenceDerivationError } from "./errors.js";
import type { MetadataTransformationSet } from "./metadata-transform.js";
import type { ParsedDerivationPolicy } from "./types.js";
import type {
  ParsedScrubberImplementationDescriptor,
  PreparedScrubReceipt,
} from "./receipt.js";
import type { ValidatedDerivationSource } from "./source.js";
import type {
  DerivationRecordReference,
  PublishableArtifact,
} from "./types.js";
import { compareCodeUnitStrings } from "./order.js";

type Entity = ExecutionEvidenceDocument["@graph"][number];

export interface BuildPublicExecutionEvidenceInput {
  readonly source: ValidatedDerivationSource;
  readonly metadata: Extract<
    MetadataTransformationSet,
    { readonly status: "transformed" }
  >;
  readonly artifacts: Extract<
    ArtifactTransformationSet,
    { readonly status: "transformed" }
  >;
  readonly policy: ParsedDerivationPolicy;
  readonly implementation: ParsedScrubberImplementationDescriptor;
  readonly receipt: PreparedScrubReceipt;
  readonly scrubberAgentId: string;
  readonly completedAt: string;
}

export interface PreparedPublicDerivative {
  readonly record: {
    readonly reference: DerivationRecordReference;
    readonly bytes: Uint8Array;
  };
  readonly artifacts: readonly PublishableArtifact[];
}

const IDS = {
  source: "private/ro-crate-metadata.json",
  policy: "provenance/derivation-policy.json",
  implementation: "provenance/scrubber-implementation.json",
  receipt: "provenance/scrub-receipt.json",
  activity: "#public-derivation",
} as const;

function entity(document: ExecutionEvidenceDocument, id: string): Entity {
  const value = document["@graph"].find((candidate) => candidate["@id"] === id);
  if (!value) {
    throw new EvidenceDerivationError(
      "DERIVATIVE_NONCONFORMING",
      `Required source entity ${id} is missing.`,
    );
  }
  return value;
}

function digestHex(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

function recursivelySorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recursivelySorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, recursivelySorted(child)]),
  );
}

function prettyBytes(value: unknown): Uint8Array {
  const serialized = JSON.stringify(recursivelySorted(value), null, 2);
  if (serialized === undefined) {
    throw new EvidenceDerivationError(
      "DERIVATIVE_NONCONFORMING",
      "Constructed public derivative cannot be serialized.",
    );
  }
  return new TextEncoder().encode(`${serialized}\n`);
}

export function buildPublicExecutionEvidence(
  input: BuildPublicExecutionEvidenceInput,
): PreparedPublicDerivative {
  const document = structuredClone(input.metadata.graph);
  const reserved = new Set([
    ...Object.values(IDS),
    input.scrubberAgentId,
    ...input.artifacts.derived.map(({ entityId }) => entityId),
  ]);
  for (const existing of document["@graph"]) {
    if (reserved.has(existing["@id"])) {
      throw new EvidenceDerivationError(
        "DERIVATIVE_NONCONFORMING",
        "Source graph collides with a derivation entity id.",
      );
    }
  }
  const root = entity(document, "./");
  root.name = "Public representation of Execution Evidence";
  root.description =
    "Structure-aware public derivative retaining exact historical commitments.";
  root.dateCreated = input.completedAt;
  root.datePublished = input.completedAt;
  root.creator = { "@id": input.scrubberAgentId };
  root["prov:wasDerivedFrom"] = { "@id": IDS.source };
  root["prov:wasGeneratedBy"] = { "@id": IDS.activity };

  const sourceCommitment: Entity = {
    "@id": IDS.source,
    "@type": ["File", "CreativeWork"],
    name: "Unavailable exact private Execution Evidence metadata commitment",
    encodingFormat: "application/ld+json",
    sha256: digestHex(input.source.recordDigest),
  };
  const policyEntity: Entity = {
    "@id": IDS.policy,
    "@type": ["File", "CreativeWork"],
    name: "Exact evidence derivation policy",
    encodingFormat: "application/json",
    sha256: digestHex(input.policy.digest),
  };
  const implementationEntity: Entity = {
    "@id": IDS.implementation,
    "@type": ["File", "CreativeWork"],
    name: "Content-bound scrubber implementation descriptor",
    encodingFormat: "application/json",
    sha256: digestHex(input.implementation.digest),
  };
  const receiptEntity: Entity = {
    "@id": IDS.receipt,
    "@type": ["File", "CreativeWork"],
    name: "Evidence derivation scrub receipt",
    encodingFormat: "application/json",
    sha256: digestHex(input.receipt.digest),
    "prov:wasDerivedFrom": { "@id": IDS.source },
    "prov:wasGeneratedBy": { "@id": IDS.activity },
  };
  const scrubber: Entity = {
    "@id": input.scrubberAgentId,
    "@type": ["SoftwareApplication", "prov:Agent"],
    name: input.implementation.value.name,
    softwareVersion: input.implementation.value.version,
    subjectOf: { "@id": IDS.implementation },
  };
  const dispositionCounts = input.receipt.value.dispositions;
  const countEntities: Entity[] = dispositionCounts.map((count, index) => ({
    "@id": `#derivation-disposition-${index}`,
    "@type": "PropertyValue",
    name: `${count.class}:${count.disposition}`,
    propertyID: `https://spec.jinn.network/terms/dispositions/${encodeURIComponent(count.class)}/${count.disposition}`,
    value: count.count,
    unitCode: "count",
  }));
  const activity: Entity = {
    "@id": IDS.activity,
    "@type": "prov:Activity",
    name: "Structure-aware public derivation",
    endTime: input.completedAt,
    agent: { "@id": input.scrubberAgentId },
    instrument: { "@id": IDS.policy },
    "jinn:dispositionCount": countEntities.map(({ "@id": id }) => ({
      "@id": id,
    })),
  };

  const derivedEntities: Entity[] = input.artifacts.derived.map((derived) => {
    const source = entity(document, derived.sourceEntityId);
    return {
      ...structuredClone(source),
      "@id": derived.entityId,
      name:
        typeof source.name === "string"
          ? `${source.name} public derivative`
          : "Public derived artifact",
      sha256: digestHex(derived.digest),
      "prov:wasDerivedFrom": { "@id": derived.sourceEntityId },
      "prov:wasGeneratedBy": { "@id": IDS.activity },
    };
  });

  const hasPartIds = [
    ...input.artifacts.retained.map(({ entityId }) => entityId),
    ...input.artifacts.derived.map(({ entityId }) => entityId),
    IDS.policy,
    IDS.implementation,
    IDS.receipt,
  ].sort();
  root.hasPart = hasPartIds.map((id) => ({ "@id": id }));
  document["@graph"].push(
    sourceCommitment,
    policyEntity,
    implementationEntity,
    receiptEntity,
    scrubber,
    activity,
    ...countEntities,
    ...derivedEntities,
  );
  const descriptor = entity(document, "ro-crate-metadata.json");
  document["@graph"].sort((left, right) => {
    if (left === descriptor) return -1;
    if (right === descriptor) return 1;
    if (left === root) return -1;
    if (right === root) return 1;
    return compareCodeUnitStrings(left["@id"], right["@id"]);
  });
  const metadataBytes = prettyBytes(document);
  const validation = validateExecutionEvidence(metadataBytes);
  if (!validation.conforms) {
    throw new EvidenceDerivationError(
      "DERIVATIVE_NONCONFORMING",
      "Constructed public derivative does not conform.",
      { details: validation.diagnostics },
    );
  }
  const reference: DerivationRecordReference = {
    family: "execution-evidence",
    digest: recordDigest(metadataBytes),
  };
  const artifacts: PublishableArtifact[] = [
    ...input.artifacts.retained.map((artifact) => ({
      ...artifact,
      bytes: copyBytes(artifact.bytes),
    })),
    ...input.artifacts.derived.map((artifact) => ({
      entityId: artifact.entityId,
      digest: artifact.digest,
      bytes: copyBytes(artifact.bytes),
      kind: "derived" as const,
    })),
    {
      entityId: IDS.policy,
      digest: input.policy.digest,
      bytes: copyBytes(input.policy.bytes),
      kind: "policy",
    },
    {
      entityId: IDS.implementation,
      digest: input.implementation.digest,
      bytes: copyBytes(input.implementation.bytes),
      kind: "implementation",
    },
    {
      entityId: IDS.receipt,
      digest: input.receipt.digest,
      bytes: copyBytes(input.receipt.bytes),
      kind: "receipt",
    },
  ];
  artifacts.sort((left, right) => compareCodeUnitStrings(left.entityId, right.entityId));
  return Object.freeze({
    record: Object.freeze({
      reference,
      bytes: copyBytes(metadataBytes),
    }),
    artifacts: Object.freeze(artifacts),
  });
}
