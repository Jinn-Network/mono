import canonicalize from "canonicalize";

import {
  EvidenceRepositoryError,
  createArtifactReference,
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";

export const OCI_EVIDENCE_PROFILE_URI =
  "https://spec.jinn.network/profiles/evidence-repository-oci/v1";
export const OCI_EVIDENCE_PROFILE_VERSION = "1.0.0";
export const OCI_EVIDENCE_PROFILE_ANNOTATION =
  "network.jinn.evidence.profile";

export const OCI_IMAGE_MANIFEST_MEDIA_TYPE =
  "application/vnd.oci.image.manifest.v1+json";
export const OCI_EMPTY_JSON_MEDIA_TYPE =
  "application/vnd.oci.empty.v1+json";
export const OCI_EMPTY_JSON_DIGEST =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
export const OCI_EMPTY_JSON_BYTES = new TextEncoder().encode("{}");

export const OCI_EVIDENCE_ARTIFACT_TYPES = {
  "execution-evidence":
    "application/vnd.jinn.execution-evidence.v1+json",
  "result-evaluation":
    "application/vnd.jinn.result-evaluation.v1+json",
  "execution-verification":
    "application/vnd.jinn.execution-verification.v1+json",
  artifact: "application/vnd.jinn.evidence-artifact.v1",
} as const;

export interface OciDescriptor {
  readonly mediaType: string;
  readonly digest: Sha256Digest;
  readonly size: number;
}

export interface EvidenceOciManifest {
  readonly schemaVersion: 2;
  readonly mediaType: typeof OCI_IMAGE_MANIFEST_MEDIA_TYPE;
  readonly artifactType:
    (typeof OCI_EVIDENCE_ARTIFACT_TYPES)[keyof typeof OCI_EVIDENCE_ARTIFACT_TYPES];
  readonly config: OciDescriptor;
  readonly layers: readonly [OciDescriptor];
  readonly annotations: Readonly<Record<
    typeof OCI_EVIDENCE_PROFILE_ANNOTATION,
    typeof OCI_EVIDENCE_PROFILE_URI
  >>;
}

export interface EvidenceOciManifestValidation {
  readonly manifest: EvidenceOciManifest;
  readonly manifestDigest: Sha256Digest;
  readonly contentDigest: Sha256Digest;
  readonly contentSize: number;
}

export const OCI_EMPTY_CONFIG_DESCRIPTOR: OciDescriptor = Object.freeze({
  mediaType: OCI_EMPTY_JSON_MEDIA_TYPE,
  digest: OCI_EMPTY_JSON_DIGEST,
  size: OCI_EMPTY_JSON_BYTES.byteLength,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function corrupt(message: string, cause?: unknown): never {
  throw new EvidenceRepositoryError("CONTENT_CORRUPT", message, {
    cause,
  });
}

function isRecordReference(
  reference: EvidenceRecordReference | EvidenceArtifactReference,
): reference is EvidenceRecordReference {
  return "family" in reference;
}

function parseReference(
  reference: EvidenceRecordReference | EvidenceArtifactReference,
): EvidenceRecordReference | EvidenceArtifactReference {
  return isRecordReference(reference)
    ? parseEvidenceRecordReference(reference)
    : parseEvidenceArtifactReference(reference);
}

function artifactTypeFor(
  reference: EvidenceRecordReference | EvidenceArtifactReference,
): EvidenceOciManifest["artifactType"] {
  return isRecordReference(reference)
    ? OCI_EVIDENCE_ARTIFACT_TYPES[reference.family]
    : OCI_EVIDENCE_ARTIFACT_TYPES.artifact;
}

function assertContentSize(size: unknown): asserts size is number {
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      "OCI content size must be a non-negative safe integer.",
    );
  }
}

export function recordLookupTag(
  untrustedReference: EvidenceRecordReference,
): string {
  const reference = parseEvidenceRecordReference(untrustedReference);
  return `${reference.family}-sha256-${reference.digest.slice("sha256:".length)}`;
}

export function artifactLookupTag(
  untrustedReference: EvidenceArtifactReference,
): string {
  const reference = parseEvidenceArtifactReference(untrustedReference);
  return `artifact-sha256-${reference.digest.slice("sha256:".length)}`;
}

export function evidenceLookupTag(
  reference: EvidenceRecordReference | EvidenceArtifactReference,
): string {
  return isRecordReference(reference)
    ? recordLookupTag(reference)
    : artifactLookupTag(reference);
}

export function buildEvidenceOciManifest(
  untrustedReference: EvidenceRecordReference | EvidenceArtifactReference,
  size: number,
): EvidenceOciManifest {
  const reference = parseReference(untrustedReference);
  assertContentSize(size);
  const artifactType = artifactTypeFor(reference);

  return {
    schemaVersion: 2,
    mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    artifactType,
    config: { ...OCI_EMPTY_CONFIG_DESCRIPTOR },
    layers: [
      {
        mediaType: artifactType,
        digest: reference.digest,
        size,
      },
    ],
    annotations: {
      [OCI_EVIDENCE_PROFILE_ANNOTATION]: OCI_EVIDENCE_PROFILE_URI,
    },
  };
}

export function canonicalizeEvidenceOciManifest(
  value: unknown,
): Uint8Array {
  let canonical: string | undefined;
  try {
    canonical = canonicalize(value);
  } catch (error) {
    corrupt("OCI manifest cannot be canonicalized with RFC 8785.", error);
  }
  if (canonical === undefined) {
    corrupt("OCI manifest contains a value unsupported by RFC 8785.");
  }
  return encoder.encode(canonical);
}

export function evidenceOciManifestDigest(
  manifest: EvidenceOciManifest,
): Sha256Digest {
  return createArtifactReference(
    canonicalizeEvidenceOciManifest(manifest),
  ).digest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    corrupt(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

function assertDescriptor(
  value: unknown,
  expected: OciDescriptor,
  label: string,
): void {
  if (!isPlainObject(value)) corrupt(`${label} must be an object.`);
  assertExactKeys(value, ["mediaType", "digest", "size"], label);
  if (
    value.mediaType !== expected.mediaType ||
    value.digest !== expected.digest ||
    value.size !== expected.size
  ) {
    corrupt(`${label} does not match the required descriptor.`);
  }
}

export function validateEvidenceOciManifest(
  manifestBytes: Uint8Array,
  untrustedReference: EvidenceRecordReference | EvidenceArtifactReference,
  expectedSize?: number,
): EvidenceOciManifestValidation {
  const reference = parseReference(untrustedReference);
  if (expectedSize !== undefined) assertContentSize(expectedSize);

  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(manifestBytes));
  } catch (error) {
    corrupt("OCI manifest bytes must be valid UTF-8 JSON.", error);
  }
  if (!isPlainObject(value)) corrupt("OCI manifest must be an object.");
  const canonicalBytes = canonicalizeEvidenceOciManifest(value);
  if (!Buffer.from(canonicalBytes).equals(Buffer.from(manifestBytes))) {
    corrupt("OCI manifest bytes must use RFC 8785 canonical JSON.");
  }

  assertExactKeys(
    value,
    [
      "schemaVersion",
      "mediaType",
      "artifactType",
      "config",
      "layers",
      "annotations",
    ],
    "OCI manifest",
  );
  const expectedArtifactType = artifactTypeFor(reference);
  if (
    value.schemaVersion !== 2 ||
    value.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE ||
    value.artifactType !== expectedArtifactType
  ) {
    corrupt("OCI manifest type fields do not match the evidence reference.");
  }
  assertDescriptor(value.config, OCI_EMPTY_CONFIG_DESCRIPTOR, "OCI config");

  if (!Array.isArray(value.layers) || value.layers.length !== 1) {
    corrupt("OCI manifest must contain exactly one content layer.");
  }
  const layer = value.layers[0];
  if (!isPlainObject(layer)) corrupt("OCI content layer must be an object.");
  assertExactKeys(layer, ["mediaType", "digest", "size"], "OCI content layer");
  if (
    layer.mediaType !== expectedArtifactType ||
    layer.digest !== reference.digest ||
    typeof layer.size !== "number" ||
    !Number.isSafeInteger(layer.size) ||
    layer.size < 0 ||
    (expectedSize !== undefined && layer.size !== expectedSize)
  ) {
    corrupt("OCI content layer does not match the evidence reference.");
  }

  if (!isPlainObject(value.annotations)) {
    corrupt("OCI manifest annotations must be an object.");
  }
  assertExactKeys(
    value.annotations,
    [OCI_EVIDENCE_PROFILE_ANNOTATION],
    "OCI manifest annotations",
  );
  if (
    value.annotations[OCI_EVIDENCE_PROFILE_ANNOTATION] !==
    OCI_EVIDENCE_PROFILE_URI
  ) {
    corrupt("OCI manifest does not declare the required profile.");
  }

  return {
    manifest: value as unknown as EvidenceOciManifest,
    manifestDigest: createArtifactReference(manifestBytes).digest,
    contentDigest: reference.digest,
    contentSize: layer.size,
  };
}

export function artifactTypeForRecordFamily(
  family: EvidenceRecordFamily,
): EvidenceOciManifest["artifactType"] {
  return OCI_EVIDENCE_ARTIFACT_TYPES[family];
}
