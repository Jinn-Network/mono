import { decodeUtf8 } from "./bytes.js";
import { EvidenceDerivationError } from "./errors.js";
import { classifyTechnicalValue } from "./technical-values.js";
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

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function selectorMatches(selector: string, pointer: string): boolean {
  const expected = selector.split("/").slice(1);
  const actual = pointer.split("/").slice(1);
  return (
    expected.length === actual.length &&
    expected.every(
      (segment, index) =>
        segment === actual[index] ||
        (segment === "*" && /^\d+$/.test(actual[index] ?? "")),
    )
  );
}

function matches(selectors: readonly string[], pointer: string): boolean {
  return selectors.some((selector) => selectorMatches(selector, pointer));
}

function protectedClassFor(
  key: string,
  value: unknown,
): ProtectedValueClass {
  if (key === "agent" || key === "creator") return "agent-iri";
  if (key.startsWith("@")) return "jsonld-keyword";
  if (
    [
      "about",
      "agent",
      "conformsTo",
      "creator",
      "hasPart",
      "instrument",
      "license",
      "mentions",
      "object",
      "prov:wasDerivedFrom",
      "prov:wasGeneratedBy",
      "provider",
      "resourceUsage",
      "result",
      "subjectOf",
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
  entityId: string,
  policy: DerivationPolicy,
  surfaces: DerivationSurface[],
  protectedLocations: ProtectedLocation[],
): boolean {
  if (Array.isArray(value)) {
    return value.every((child, index) =>
      walkMetadata(
        child,
        `${pointer}/${index}`,
        entityId,
        policy,
        surfaces,
        protectedLocations,
      ),
    );
  }
  if (!value || typeof value !== "object") return true;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) return false;
    const child = descriptor.value;
    const childPointer = `${pointer}/${escapePointer(key)}`;
    if (
      typeof child === "string" &&
      matches(policy.transformableMetadata, childPointer)
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
      matches(policy.protectedMetadata, childPointer)
    ) {
      protectedLocations.push({
        location: childPointer,
        protectedClass: "policy-protected-property",
      });
      continue;
    }
    if (PROTECTED_KEYS.has(key)) {
      protectedLocations.push({
        location: childPointer,
        protectedClass: protectedClassFor(key, child),
      });
      if (key === "@context") {
        markProtectedTree(
          child,
          childPointer,
          "jsonld-keyword",
          protectedLocations,
        );
        continue;
      }
      if (
        child &&
        typeof child === "object" &&
        !walkMetadata(
          child,
          childPointer,
          entityId,
          policy,
          surfaces,
          protectedLocations,
        )
      ) {
        return false;
      }
      continue;
    }
    if (PROTOCOL_SCALARS.has(key)) {
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
          entityId,
          policy,
          surfaces,
          protectedLocations,
        )
      ) {
        continue;
      }
      return false;
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

function structuredSurfaces(
  entityId: string,
  role: DerivationSurface["role"],
  mediaType: string,
  codec: "json" | "jsonl",
  bytes: Uint8Array,
): DerivationSurface[] {
  const text = decodeUtf8(bytes);
  const rows = codec === "jsonl" ? text.split("\n") : [text];
  const surfaces: DerivationSurface[] = [];
  rows.forEach((row, lineIndex) => {
    if (codec === "jsonl" && row.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
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
        for (const [key, child] of Object.entries(value)) {
          walk(child, `${path}/${escapePointer(key)}`, key);
        }
      } else if (
        typeof value === "string" &&
        classifyTechnicalValue(value, { field }) === null
      ) {
        surfaces.push({
          surfaceId: `artifact:${entityId}:${codec === "jsonl" ? `line-${lineIndex + 1}` : "root"}${path}`,
          sourceEntityId: entityId,
          role,
          mediaType,
          codec,
          location: codec === "jsonl" ? `/${lineIndex}${path}` : path,
          text: value,
        });
      }
    };
    walk(parsed, "");
  });
  return surfaces;
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
      "ro-crate-metadata.json",
      policy,
      surfaces,
      protectedLocations,
    )
  ) {
    return { surfaces: [], protectedLocations, hold: { code: "unclassified-metadata" } };
  }
  for (const location of protectedLocations) {
    if (
      policy.protectedValueDispositions[location.protectedClass] ===
      "withhold-record"
    ) {
      return {
        surfaces: [],
        protectedLocations,
        hold: {
          code: "protected-value-withheld",
          protectedClass: location.protectedClass,
        },
      };
    }
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
      surfaces.push({
        surfaceId: `artifact:${entityId}:text`,
        sourceEntityId: entityId,
        role,
        mediaType,
        codec,
        location: "",
        text: decodeUtf8(bytes),
      });
    } else if (codec === "json" || codec === "jsonl") {
      surfaces.push(
        ...structuredSurfaces(entityId, role, mediaType, codec, bytes),
      );
    }
  }
  return {
    surfaces: Object.freeze(
      surfaces.sort((left, right) =>
        left.surfaceId.localeCompare(right.surfaceId),
      ),
    ),
    protectedLocations: Object.freeze(protectedLocations),
  };
}
