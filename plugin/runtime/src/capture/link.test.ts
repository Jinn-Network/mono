import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, afterEach, beforeEach } from "vitest";

import { TRAJECTORY_RECORD_IDENTIFIER_PROPERTY } from "@jinn-network/evidence-trajectory";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";

import { PluginRuntimeError } from "../errors.js";
import { resolveRuntimeConfig } from "../config.js";
import {
  derivationLinkPath,
  loadTrajectoryDerivationAttestation,
  loadTrajectoryRecord,
  readTrajectoryDerivationAttestationLink,
  trajectoryReferenceFromRecordBytes,
  writeTrajectoryDerivationAttestationLink,
} from "./link.js";
import { resolveCapturePaths } from "./paths.js";

const DIGEST = `sha256:${"d".repeat(64)}` as const;

const crate = (identifier: unknown): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      "@context": ["https://w3id.org/ro/crate/1.3/context"],
      "@graph": [
        { "@id": "./", "@type": "Dataset" },
        {
          "@id": "trace/feed.ndjson",
          "@type": "File",
          sha256: "e".repeat(64),
          ...(identifier === undefined ? {} : { identifier }),
        },
      ],
    }),
  );

describe("trajectoryReferenceFromRecordBytes", () => {
  test("reads the digest from the trace entity's identifier", () => {
    const bytes = crate([
      { "@type": "PropertyValue", propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY, value: DIGEST },
    ]);
    expect(trajectoryReferenceFromRecordBytes(bytes)).toEqual({ digest: DIGEST });
  });

  test("accepts a single identifier object as well as a list", () => {
    const bytes = crate({
      "@type": "PropertyValue",
      propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
      value: DIGEST,
    });
    expect(trajectoryReferenceFromRecordBytes(bytes)).toEqual({ digest: DIGEST });
  });

  test("returns null when no trajectory identifier is present", () => {
    expect(trajectoryReferenceFromRecordBytes(crate(undefined))).toBeNull();
    expect(
      trajectoryReferenceFromRecordBytes(
        crate([{ "@type": "PropertyValue", propertyID: "https://example.test/other", value: DIGEST }]),
      ),
    ).toBeNull();
  });

  test("returns null rather than throwing on unreadable bytes", () => {
    expect(trajectoryReferenceFromRecordBytes(new Uint8Array([0xff]))).toBeNull();
    expect(trajectoryReferenceFromRecordBytes(new TextEncoder().encode("not json"))).toBeNull();
    expect(trajectoryReferenceFromRecordBytes(new TextEncoder().encode("{}"))).toBeNull();
  });

  test("rejects a malformed digest value", () => {
    expect(
      trajectoryReferenceFromRecordBytes(
        crate([
          {
            "@type": "PropertyValue",
            propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
            value: "sha256:not-a-digest",
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("loadTrajectoryRecord", () => {
  test("parses the stored artifact under C1's schema", async () => {
    const { buildTrajectoryRecord } = await import("./trajectory.js");
    const { parseSessionFeed } = await import("./feed.js");
    const { readFile } = await import("node:fs/promises");
    const feedBytes = new Uint8Array(
      await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url)),
    );
    const built = buildTrajectoryRecord(parseSessionFeed(feedBytes), feedBytes);
    const repository = {
      getArtifact: async () => built.bytes,
    } as unknown as Parameters<typeof loadTrajectoryRecord>[0];
    const record = await loadTrajectoryRecord(repository, { digest: built.digest });
    expect(record.traceId).toBe(built.traceId);
  });

  test("throws when the artifact is absent", async () => {
    const repository = {
      getArtifact: async () => null,
    } as unknown as Parameters<typeof loadTrajectoryRecord>[0];
    await expect(loadTrajectoryRecord(repository, { digest: DIGEST })).rejects.toThrow(/not present/u);
  });
});

const EXECUTION_DIGEST = `sha256:${"b".repeat(64)}` as const;
const TRAJECTORY_DIGEST = `sha256:${"c".repeat(64)}` as const;
const ATTESTATION_DIGEST = `sha256:${"a".repeat(64)}` as const;
const NATIVE_DIGEST = `sha256:${"d".repeat(64)}` as const;

const sampleLink = () => ({
  version: 1 as const,
  executionDigest: EXECUTION_DIGEST,
  trajectoryDigest: TRAJECTORY_DIGEST,
  attestationDigest: ATTESTATION_DIGEST,
  nativeTraceDigest: NATIVE_DIGEST,
  derivedAt: "2026-07-30T09:00:06Z",
});

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-capture-link-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("derivation attestation link", () => {
  test("derives the link path from the execution digest", () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    expect(derivationLinkPath(paths, EXECUTION_DIGEST)).toBe(
      join(paths.derivationLinksDirectory, "b".repeat(64) + ".json"),
    );
  });

  test("round-trips a link through write and read", async () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    const link = sampleLink();
    await writeTrajectoryDerivationAttestationLink(paths, link);
    expect(await readTrajectoryDerivationAttestationLink(paths, EXECUTION_DIGEST)).toEqual(link);
  });

  test("returns null when no link exists", async () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    expect(await readTrajectoryDerivationAttestationLink(paths, EXECUTION_DIGEST)).toBeNull();
  });

  test("duplicate write of the same link succeeds", async () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    const link = sampleLink();
    await writeTrajectoryDerivationAttestationLink(paths, link);
    await expect(writeTrajectoryDerivationAttestationLink(paths, link)).resolves.toBeUndefined();
  });

  test("rejects a mismatched rewrite", async () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    await writeTrajectoryDerivationAttestationLink(paths, sampleLink());
    await expect(
      writeTrajectoryDerivationAttestationLink(paths, {
        ...sampleLink(),
        trajectoryDigest: `sha256:${"e".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "capture-derivation-link-mismatch" });
  });

  test("loads attestation bytes and statement from the archive", async () => {
    const { buildTrajectoryDerivationStatement, sealTrajectoryDerivationAttestation, TRAJECTORY_VOCABULARY_PROFILE } =
      await import("@jinn-network/evidence-trajectory");
    const statement = buildTrajectoryDerivationStatement({
      producerId: "https://jinn.network/software/plugin-runtime",
      executionDigest: EXECUTION_DIGEST,
      trajectoryDigest: TRAJECTORY_DIGEST,
      nativeTraceDigest: NATIVE_DIGEST,
      formatIri: "https://jinn.network/formats/agent-session-feed/v1",
      decoderId: "agent-session-feed",
      decoderVersion: "1.0.0",
      vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
      timebase: "source-epoch-ns",
      linkageMode: "forward-linked",
      derivedAt: "2026-07-30T09:00:06Z",
    });
    const sealed = await sealTrajectoryDerivationAttestation({
      statement,
      signer: async () => [{ signature: new Uint8Array([9]), keyid: "k" }],
    });
    const repository = new InMemoryEvidenceRepository();
    await repository.putArtifact(sealed.envelopeBytes);
    const link = { ...sampleLink(), attestationDigest: sealed.digest };
    const loaded = await loadTrajectoryDerivationAttestation(repository, link);
    expect(loaded.envelopeBytes).toEqual(sealed.envelopeBytes);
    expect(loaded.statement.predicate.derivedAt).toBe("2026-07-30T09:00:06Z");
  });
});
