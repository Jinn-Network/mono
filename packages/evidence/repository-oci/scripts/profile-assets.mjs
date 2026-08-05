import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";

import {
  OCI_EMPTY_CONFIG_DESCRIPTOR,
  OCI_EVIDENCE_ARTIFACT_TYPES,
  OCI_EVIDENCE_PROFILE_ANNOTATION,
  OCI_EVIDENCE_PROFILE_URI,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  buildEvidenceOciManifest,
  canonicalizeEvidenceOciManifest,
  evidenceLookupTag,
} from "../dist/index.js";

const encoder = new TextEncoder();

function descriptorSchema({
  mediaType,
  digest,
  size,
}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["mediaType", "digest", "size"],
    properties: {
      mediaType: { const: mediaType },
      digest: digest
        ? { const: digest }
        : { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      size: size === undefined
        ? { type: "integer", minimum: 0 }
        : { const: size },
    },
  };
}

function manifestVariant(artifactType) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "mediaType",
      "artifactType",
      "config",
      "layers",
      "annotations",
    ],
    properties: {
      schemaVersion: { const: 2 },
      mediaType: { const: OCI_IMAGE_MANIFEST_MEDIA_TYPE },
      artifactType: { const: artifactType },
      config: descriptorSchema(OCI_EMPTY_CONFIG_DESCRIPTOR),
      layers: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        prefixItems: [
          descriptorSchema({ mediaType: artifactType }),
        ],
        items: false,
      },
      annotations: {
        type: "object",
        additionalProperties: false,
        required: [OCI_EVIDENCE_PROFILE_ANNOTATION],
        properties: {
          [OCI_EVIDENCE_PROFILE_ANNOTATION]: {
            const: OCI_EVIDENCE_PROFILE_URI,
          },
        },
      },
    },
  };
}

export const manifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${OCI_EVIDENCE_PROFILE_URI}/schemas/evidence-oci-manifest.schema.json`,
  title: "Jinn Evidence Repository OCI Manifest",
  description:
    "Canonical OCI Image Manifest serialization for one exact Jinn evidence record or artifact.",
  oneOf: Object.values(OCI_EVIDENCE_ARTIFACT_TYPES).map(manifestVariant),
};

const fixtureDefinitions = [
  {
    name: "execution-evidence",
    content: "golden execution evidence\n",
    reference(bytes) {
      return createRecordReference("execution-evidence", bytes);
    },
  },
  {
    name: "result-evaluation",
    content: "golden result evaluation\n",
    reference(bytes) {
      return createRecordReference("result-evaluation", bytes);
    },
  },
  {
    name: "execution-verification",
    content: "golden execution verification\n",
    reference(bytes) {
      return createRecordReference("execution-verification", bytes);
    },
  },
  {
    name: "artifact",
    content: "golden generic artifact\n",
    reference(bytes) {
      return createArtifactReference(bytes);
    },
  },
];

export function createProfileAssets() {
  const assets = new Map();
  assets.set(
    "profiles/evidence-repository-oci/v1/schemas/evidence-oci-manifest.schema.json",
    encoder.encode(`${JSON.stringify(manifestSchema, null, 2)}\n`),
  );

  const expected = {};
  for (const fixture of fixtureDefinitions) {
    const contentBytes = encoder.encode(fixture.content);
    const reference = fixture.reference(contentBytes);
    const manifest = buildEvidenceOciManifest(
      reference,
      contentBytes.byteLength,
    );
    const manifestBytes = canonicalizeEvidenceOciManifest(manifest);
    const manifestDigest = createArtifactReference(manifestBytes).digest;
    const contentPath =
      `fixtures/golden-oci-mapping/${fixture.name}.content`;
    const manifestPath =
      `fixtures/golden-oci-mapping/${fixture.name}.manifest.json`;
    assets.set(contentPath, contentBytes);
    assets.set(manifestPath, manifestBytes);
    expected[fixture.name] = {
      reference,
      size: contentBytes.byteLength,
      artifactType: manifest.artifactType,
      lookupTag: evidenceLookupTag(reference),
      manifestDigest,
      manifestPath,
      contentPath,
    };
  }

  assets.set(
    "fixtures/golden-oci-mapping/expected-digests.json",
    encoder.encode(`${JSON.stringify(expected, null, 2)}\n`),
  );
  return assets;
}
