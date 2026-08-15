import { readFile } from "node:fs/promises";

import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import {
  OCI_EMPTY_CONFIG_DESCRIPTOR,
  OCI_EVIDENCE_ARTIFACT_TYPES,
  OCI_EVIDENCE_PROFILE_ANNOTATION,
  OCI_EVIDENCE_PROFILE_URI,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  artifactLookupTag,
  buildEvidenceOciManifest,
  canonicalizeEvidenceOciManifest,
  evidenceOciManifestDigest,
  recordLookupTag,
  validateEvidenceOciManifest,
} from "./index.js";

const encoder = new TextEncoder();

describe("deterministic OCI mapping", () => {
  test("builds the constrained OCI Image Manifest for every record family", () => {
    for (const family of [
      "execution-evidence",
      "result-evaluation",
      "execution-verification",
    ] as const) {
      const bytes = encoder.encode(`record:${family}`);
      const reference = createRecordReference(family, bytes);
      const manifest = buildEvidenceOciManifest(reference, bytes.byteLength);

      expect(manifest).toEqual({
        schemaVersion: 2,
        mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        artifactType: OCI_EVIDENCE_ARTIFACT_TYPES[family],
        config: OCI_EMPTY_CONFIG_DESCRIPTOR,
        layers: [
          {
            mediaType: OCI_EVIDENCE_ARTIFACT_TYPES[family],
            digest: reference.digest,
            size: bytes.byteLength,
          },
        ],
        annotations: {
          [OCI_EVIDENCE_PROFILE_ANNOTATION]: OCI_EVIDENCE_PROFILE_URI,
        },
      });
      expect(
        validateEvidenceOciManifest(
          canonicalizeEvidenceOciManifest(manifest),
          reference,
        ).manifest,
      ).toEqual(manifest);
    }
  });

  test("maps generic artifact bytes to a distinct type and deterministic tag", () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const reference = createArtifactReference(bytes);
    const manifest = buildEvidenceOciManifest(reference, bytes.byteLength);

    expect(manifest.artifactType).toBe(
      OCI_EVIDENCE_ARTIFACT_TYPES.artifact,
    );
    expect(manifest.layers[0]?.mediaType).toBe(
      OCI_EVIDENCE_ARTIFACT_TYPES.artifact,
    );
    expect(artifactLookupTag(reference)).toBe(
      `artifact-sha256-${reference.digest.slice("sha256:".length)}`,
    );
  });

  test("uses family-qualified lookup aliases without treating tags as identity", () => {
    const bytes = encoder.encode("same exact bytes");
    const evaluation = createRecordReference("result-evaluation", bytes);
    const verification = createRecordReference(
      "execution-verification",
      bytes,
    );

    expect(recordLookupTag(evaluation)).toBe(
      `result-evaluation-sha256-${evaluation.digest.slice("sha256:".length)}`,
    );
    expect(recordLookupTag(verification)).toBe(
      `execution-verification-sha256-${verification.digest.slice("sha256:".length)}`,
    );
    expect(recordLookupTag(evaluation)).not.toBe(
      recordLookupTag(verification),
    );
  });

  test("canonicalizes manifests with RFC 8785 and binds their transport digest", () => {
    const bytes = encoder.encode("canonical transport");
    const reference = createRecordReference("execution-evidence", bytes);
    const manifest = buildEvidenceOciManifest(reference, bytes.byteLength);
    const canonical = canonicalizeEvidenceOciManifest(manifest);

    expect(new TextDecoder().decode(canonical)).toBe(
      `{"annotations":{"network.jinn.evidence.profile":"https://spec.jinn.network/profiles/evidence-repository-oci/v1"},"artifactType":"application/vnd.jinn.execution-evidence.v1+json","config":{"digest":"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","mediaType":"application/vnd.oci.empty.v1+json","size":2},"layers":[{"digest":"${reference.digest}","mediaType":"application/vnd.jinn.execution-evidence.v1+json","size":19}],"mediaType":"application/vnd.oci.image.manifest.v1+json","schemaVersion":2}`,
    );
    expect(evidenceOciManifestDigest(manifest)).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  test.each([
    ["extra layer", (value: any) => value.layers.push(value.layers[0])],
    ["wrong config", (value: any) => (value.config.size = 0)],
    ["wrong artifact type", (value: any) => (value.artifactType = "text/plain")],
    ["wrong layer digest", (value: any) => (value.layers[0].digest = `sha256:${"0".repeat(64)}`)],
    ["mutable timestamp", (value: any) => (value.annotations["org.opencontainers.image.created"] = "2026-01-01T00:00:00Z")],
    ["subject", (value: any) => (value.subject = value.config)],
    ["platform", (value: any) => (value.layers[0].platform = { os: "linux", architecture: "amd64" })],
  ])("rejects %s", (_name, mutate) => {
    const bytes = encoder.encode("constrained manifest");
    const reference = createRecordReference("execution-evidence", bytes);
    const manifest = structuredClone(
      buildEvidenceOciManifest(reference, bytes.byteLength),
    );
    mutate(manifest);

    expect(() =>
      validateEvidenceOciManifest(
        canonicalizeEvidenceOciManifest(manifest),
        reference,
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTENT_CORRUPT" }));
  });

  test("rejects noncanonical and malformed manifest bytes", () => {
    const bytes = encoder.encode("canonical required");
    const reference = createArtifactReference(bytes);
    const manifest = buildEvidenceOciManifest(reference, bytes.byteLength);

    expect(() =>
      validateEvidenceOciManifest(
        encoder.encode(JSON.stringify(manifest, null, 2)),
        reference,
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTENT_CORRUPT" }));
    expect(() =>
      validateEvidenceOciManifest(encoder.encode("{"), reference),
    ).toThrowError(expect.objectContaining({ code: "CONTENT_CORRUPT" }));
  });

  test("keeps the checked-in JSON Schema aligned with generated manifests", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL(
          "../profiles/evidence-repository-oci/v1/schemas/evidence-oci-manifest.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const bytes = encoder.encode("schema fixture");
    const reference = createRecordReference("result-evaluation", bytes);
    const manifest = buildEvidenceOciManifest(reference, bytes.byteLength);

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
  });
});
