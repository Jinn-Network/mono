// SPDX-License-Identifier: Apache-2.0

import { decodeUtf8 } from "./bytes.js";
import { EvidenceDerivationError } from "./errors.js";
import { parseStrictJson } from "./strict-json.js";
import {
  classifyTechnicalValue,
  isStructurallyValidDsseEnvelope,
} from "./technical-values.js";
import type {
  ArtifactCodec,
  DerivationHoldReason,
  DerivationPolicy,
  DerivationSurface,
  ProtectedValueClass,
} from "./types.js";
import type { ValidatedDerivationSource } from "./source.js";

export interface ProtectedLocation {
  readonly location: string;
  readonly protectedClass: ProtectedValueClass;
}

export interface SurfaceExtraction {
  readonly surfaces: readonly DerivationSurface[];
  readonly protectedLocations: readonly ProtectedLocation[];
  readonly hold?: DerivationHoldReason;
}

const PROTECTED_KEYS = new Set([
  "@context",
  "@graph",
  "@id",
  "@type",
  "about",
  "actionStatus",
  "agent",
  "conformsTo",
  "creator",
  "dateCreated",
  "datePublished",
  "encodingFormat",
  "endTime",
  "environment",
  "hasPart",
  "instrument",
  "jinn:dispositionCount",
  "license",
  "mentions",
  "object",
  "propertyID",
  "prov:wasDerivedFrom",
  "prov:wasGeneratedBy",
  "provider",
  "resourceUsage",
  "result",
  "sha256",
  "softwareRequirements",
  "softwareVersion",
  "startTime",
  "subjectOf",
  "unitCode",
]);

const PROTOCOL_SCALARS = new Set([
  "name",
  "description",
  "error",
  "value",
]);

const DERIVATION_COMMITMENT_IDS = new Set([
  "private/ro-crate-metadata.json",
  "provenance/derivation-policy.json",
  "provenance/scrubber-implementation.json",
  "provenance/scrub-receipt.json",
  "#public-derivation",
]);

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

type PointerSegmentKind = "array-index" | "object-property";

function selectorMatches(
  selector: string,
  pointer: string,
  segmentKinds: readonly PointerSegmentKind[],
): boolean {
  const expected = selector.split("/").slice(1);
  const actual = pointer.split("/").slice(1);
  return (
    expected.length === actual.length &&
    actual.length === segmentKinds.length &&
    expected.every(
      (segment, index) =>
        segment === "*"
          ? segmentKinds[index] === "array-index"
          : segment === actual[index],
    )
  );
}

function matches(
  selectors: readonly string[],
  pointer: string,
  segmentKinds: readonly PointerSegmentKind[],
): boolean {
  return selectors.some((selector) =>
    selectorMatches(selector, pointer, segmentKinds),
  );
}

function protectedClassFor(
  key: string,
  value: unknown,
  source: ValidatedDerivationSource,
): ProtectedValueClass {
  const referencedIds = (() => {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object") return [];
    const candidates = Array.isArray(value) ? value : [value];
    return candidates.flatMap((candidate) =>
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as Record<string, unknown>)["@id"] === "string"
        ? [(candidate as Record<string, string>)["@id"]]
        : [],
    );
  })();
  if (referencedIds.some((id) => DERIVATION_COMMITMENT_IDS.has(id))) {
    return "derivation-commitment";
  }
  if (key === "jinn:dispositionCount") {
    return "derivation-commitment";
  }
  if (key === "agent" || key === "creator" || key === "provider") {
    return "agent-iri";
  }
  if (["object", "result", "instrument", "subjectOf"].includes(key)) {
    return "historical-role-identity";
  }
  if (
    key === "about" &&
    JSON.stringify(value).includes(source.executionId)
  ) {
    return "execution-iri";
  }
  if (key === "@id" && typeof value === "string") {
    if (value === source.executionId) return "execution-iri";
    if (source.roles.has(value)) return "historical-role-identity";
    const target = source.entities.get(value);
    const targetTypes = Array.isArray(target?.["@type"])
      ? target["@type"]
      : [target?.["@type"]];
    if (targetTypes.includes("prov:Agent")) return "agent-iri";
    return "content-identifier";
  }
  if (key.startsWith("@")) return "jsonld-keyword";
  if (
    [
      "about",
      "conformsTo",
      "hasPart",
      "license",
      "mentions",
      "prov:wasDerivedFrom",
      "prov:wasGeneratedBy",
      "resourceUsage",
    ].includes(key)
  ) {
    return "relationship-reference";
  }
  if (key === "sha256") return "digest-reference";
  if (key === "softwareVersion") return "version-model-identifier";
  if (
    key === "encodingFormat" ||
    key === "propertyID" ||
    key === "unitCode"
  ) {
    return "profile-media-schema-identifier";
  }
  if (
    typeof value === "string" &&
    (value.startsWith("urn:uuid:") || value.startsWith("https://"))
  ) {
    return "content-identifier";
  }
  return "protocol-scalar";
}

function walkMetadata(
  value: unknown,
  pointer: string,
  segmentKinds: readonly PointerSegmentKind[],
  entityId: string,
  policy: DerivationPolicy,
  source: ValidatedDerivationSource,
  surfaces: DerivationSurface[],
  protectedLocations: ProtectedLocation[],
  extensionContext = false,
): boolean {
  if (Array.isArray(value)) {
    return value.every((child, index) =>
      walkMetadata(
        child,
        `${pointer}/${index}`,
        [...segmentKinds, "array-index"],
        entityId,
        policy,
        source,
        surfaces,
        protectedLocations,
        extensionContext,
      ),
    );
  }
  if (
    typeof value === "string" &&
    matches(policy.transformableMetadata, pointer, segmentKinds)
  ) {
    surfaces.push(
      Object.freeze({
        surfaceId: `metadata:${entityId}:${pointer}`,
        sourceEntityId: entityId,
        role: "other",
        mediaType: "application/ld+json",
        codec: "json",
        location: pointer,
        text: value,
      }),
    );
    return true;
  }
  if (
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null) &&
    matches(policy.protectedMetadata, pointer, segmentKinds)
  ) {
    protectedLocations.push({
      location: pointer,
      protectedClass: "policy-protected-property",
    });
    return true;
  }
  if (!value || typeof value !== "object") return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) return false;
    const child = descriptor.value;
    const childPointer = `${pointer}/${escapePointer(key)}`;
    const childSegmentKinds = [...segmentKinds, "object-property"] as const;
    if (!extensionContext && PROTECTED_KEYS.has(key)) {
      const protectedClass = protectedClassFor(key, child, source);
      protectedLocations.push({
        location: childPointer,
        protectedClass,
      });
      if (key === "@graph") {
        if (
          child &&
          typeof child === "object" &&
          walkMetadata(
            child,
            childPointer,
            childSegmentKinds,
            entityId,
            policy,
            source,
            surfaces,
            protectedLocations,
            extensionContext,
          )
        ) {
          continue;
        }
        return false;
      }
      if (key === "@context" || key === "@type") {
        markProtectedTree(
          child,
          childPointer,
          protectedClass,
          protectedLocations,
        );
        continue;
      }
      markProtectedTree(
        child,
        childPointer,
        protectedClass,
        protectedLocations,
      );
      continue;
    }
    if (
      typeof child === "string" &&
      matches(
        policy.transformableMetadata,
        childPointer,
        childSegmentKinds,
      )
    ) {
      surfaces.push(
        Object.freeze({
          surfaceId: `metadata:${entityId}:${childPointer}`,
          sourceEntityId: entityId,
          role: "other",
          mediaType: "application/ld+json",
          codec: "json",
          location: childPointer,
          text: child,
        }),
      );
      continue;
    }
    if (
      (typeof child === "string" ||
        typeof child === "number" ||
        typeof child === "boolean" ||
        child === null) &&
      matches(policy.protectedMetadata, childPointer, childSegmentKinds)
    ) {
      protectedLocations.push({
        location: childPointer,
        protectedClass: "policy-protected-property",
      });
      continue;
    }
    if (!extensionContext && PROTOCOL_SCALARS.has(key)) {
      if (
        typeof child === "string" ||
        typeof child === "number" ||
        typeof child === "boolean" ||
        child === null
      ) {
        protectedLocations.push({
          location: childPointer,
          protectedClass: "protocol-scalar",
        });
        continue;
      }
      if (
        child &&
        typeof child === "object" &&
        walkMetadata(
          child,
          childPointer,
          childSegmentKinds,
          entityId,
          policy,
          source,
          surfaces,
          protectedLocations,
          extensionContext,
        )
      ) {
        continue;
      }
      return false;
    }
    if (
      child &&
      typeof child === "object" &&
      (Array.isArray(child)
        ? child.length > 0
        : Reflect.ownKeys(Object.getOwnPropertyDescriptors(child)).length >
          0) &&
      walkMetadata(
        child,
        childPointer,
        childSegmentKinds,
        entityId,
        policy,
        source,
        surfaces,
        protectedLocations,
        true,
      )
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function markProtectedTree(
  value: unknown,
  pointer: string,
  protectedClass: ProtectedValueClass,
  protectedLocations: ProtectedLocation[],
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      markProtectedTree(
        child,
        `${pointer}/${index}`,
        protectedClass,
        protectedLocations,
      ),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${escapePointer(key)}`;
      protectedLocations.push({ location: childPointer, protectedClass });
      markProtectedTree(child, childPointer, protectedClass, protectedLocations);
    }
  }
}

function ruleCodec(
  policy: DerivationPolicy,
  mediaType: string,
  role: string,
): ArtifactCodec | undefined {
  const rule = policy.artifactRules.find(
    (candidate) =>
      candidate.roles.includes(role as never) &&
      (candidate.mediaType === mediaType ||
        (candidate.mediaType.endsWith("/*") &&
          mediaType.startsWith(candidate.mediaType.slice(0, -1)))),
  );
  return rule?.codec;
}

function technicalProtectedClass(
  technicalClass: NonNullable<
    ReturnType<typeof classifyTechnicalValue>
  >,
): ProtectedValueClass {
  switch (technicalClass) {
    case "digest":
    case "transaction-digest":
      return "digest-reference";
    case "cid":
      return "content-identifier";
    case "dsse-material":
    case "public-key":
      return "signed-material";
    case "version":
    case "model-id":
      return "version-model-identifier";
  }
}

function structuredSurfaces(
  entityId: string,
  role: DerivationSurface["role"],
  mediaType: string,
  codec: "json" | "jsonl",
  bytes: Uint8Array,
): {
  readonly surfaces: readonly DerivationSurface[];
  readonly protectedLocations: readonly ProtectedLocation[];
} {
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch (cause) {
    throw new EvidenceDerivationError(
      "STRUCTURED_ARTIFACT_INVALID",
      "Structured artifact is not valid UTF-8.",
      { cause },
    );
  }
  const rows = codec === "jsonl" ? text.split("\n") : [text];
  const surfaces: DerivationSurface[] = [];
  const protectedLocations: ProtectedLocation[] = [];
  rows.forEach((row, lineIndex) => {
    if (codec === "jsonl" && row.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = parseStrictJson(
        row,
        codec === "jsonl"
          ? `Structured artifact is invalid at line ${lineIndex + 1}.`
          : "Structured artifact is invalid.",
        "STRUCTURED_ARTIFACT_INVALID",
      );
    } catch (cause) {
      throw new EvidenceDerivationError(
        "STRUCTURED_ARTIFACT_INVALID",
        codec === "jsonl"
          ? `Structured artifact is invalid at line ${lineIndex + 1}.`
          : "Structured artifact is invalid.",
        { cause },
      );
    }
    const walk = (value: unknown, path: string, field?: string): void => {
      if (Array.isArray(value)) {
        value.forEach((child, index) => walk(child, `${path}/${index}`, field));
      } else if (value && typeof value === "object") {
        if (isStructurallyValidDsseEnvelope(value)) {
          const protectedPath =
            codec === "jsonl" ? `/${lineIndex}${path}` : path;
          protectedLocations.push({
            location: protectedPath,
            protectedClass: "signed-material",
          });
          markProtectedTree(
            value,
            protectedPath,
            "signed-material",
            protectedLocations,
          );
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          walk(child, `${path}/${escapePointer(key)}`, key);
        }
      } else if (typeof value === "string") {
        const location = codec === "jsonl" ? `/${lineIndex}${path}` : path;
        const technicalClass = classifyTechnicalValue(value, { field });
        if (technicalClass) {
          protectedLocations.push({
            location,
            protectedClass: technicalProtectedClass(technicalClass),
          });
        } else {
          surfaces.push(Object.freeze({
            surfaceId: `artifact:${entityId}:${codec === "jsonl" ? `line-${lineIndex + 1}` : "root"}${path}`,
            sourceEntityId: entityId,
            role,
            mediaType,
            codec,
            location,
            text: value,
          }));
        }
      }
    };
    walk(parsed, "");
  });
  return {
    surfaces: Object.freeze(surfaces),
    protectedLocations: Object.freeze(protectedLocations),
  };
}

export function extractDerivationSurfaces(
  source: ValidatedDerivationSource,
  policy: DerivationPolicy,
): SurfaceExtraction {
  const surfaces: DerivationSurface[] = [];
  const protectedLocations: ProtectedLocation[] = [];
  const root: Record<string, unknown> = {
    "@context": source.document["@context"],
    "@graph": source.document["@graph"],
  };
  if (
    !walkMetadata(
      root,
      "",
      [],
      "ro-crate-metadata.json",
      policy,
      source,
      surfaces,
      protectedLocations,
    )
  ) {
    return { surfaces: [], protectedLocations, hold: { code: "unclassified-metadata" } };
  }
  for (const [entityId, bytes] of source.artifacts) {
    const entity = source.entities.get(entityId);
    if (!entity) continue;
    const mediaType =
      typeof entity.encodingFormat === "string"
        ? entity.encodingFormat
        : "application/octet-stream";
    const role = source.roles.get(entityId) ?? "other";
    const codec = ruleCodec(policy, mediaType, role);
    if (codec === "text") {
      surfaces.push(Object.freeze({
        surfaceId: `artifact:${entityId}:text`,
        sourceEntityId: entityId,
        role,
        mediaType,
        codec,
        location: "",
        text: decodeUtf8(bytes),
      }));
    } else if (codec === "json" || codec === "jsonl") {
      const structured = structuredSurfaces(
        entityId,
        role,
        mediaType,
        codec,
        bytes,
      );
      surfaces.push(...structured.surfaces);
      protectedLocations.push(...structured.protectedLocations);
    } else if (codec === "signed") {
      protectedLocations.push({
        location: "",
        protectedClass: "signed-material",
      });
    }
  }
  for (const location of protectedLocations) {
    if (
      policy.protectedValueDispositions[location.protectedClass] ===
      "withhold-record"
    ) {
      return {
        surfaces: [],
        protectedLocations: Object.freeze(protectedLocations),
        hold: {
          code: "protected-value-withheld",
          protectedClass: location.protectedClass,
        },
      };
    }
  }
  return {
    surfaces: Object.freeze(
      surfaces.sort((left, right) =>
        left.surfaceId.localeCompare(right.surfaceId),
      ),
    ),
    protectedLocations: Object.freeze(
      protectedLocations.map((location) => Object.freeze({ ...location })),
    ),
  };
}
