import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, afterEach, beforeEach } from "vitest";

import { TRACE_RECORD_IDENTIFIER_PROPERTY } from "@jinn-network/evidence-trace";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";

import { PluginRuntimeError } from "../errors.js";
import { resolveRuntimeConfig } from "../config.js";
import {
  derivationLinkPath,
  loadTraceDerivationAttestation,
  loadTraceRecord,
  readTraceDerivationAttestationLink,
  traceReferenceFromRecordBytes,
  writeTraceDerivationAttestationLink,
} from "./link.js";
import { ensureOwnerOnlyDirectory, resolveCapturePaths } from "./paths.js";

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

describe("traceReferenceFromRecordBytes", () => {
  test("reads the digest from the trace entity's identifier", () => {
    const bytes = crate([
      { "@type": "PropertyValue", propertyID: TRACE_RECORD_IDENTIFIER_PROPERTY, value: DIGEST },
    ]);
    expect(traceReferenceFromRecordBytes(bytes)).toEqual({ digest: DIGEST });
  });

  test("accepts a single identifier object as well as a list", () => {
    const bytes = crate({
      "@type": "PropertyValue",
      propertyID: TRACE_RECORD_IDENTIFIER_PROPERTY,
      value: DIGEST,
    });
    expect(traceReferenceFromRecordBytes(bytes)).toEqual({ digest: DIGEST });
  });

  test("returns null when no trace identifier is present", () => {
    expect(traceReferenceFromRecordBytes(crate(undefined))).toBeNull();
    expect(
      traceReferenceFromRecordBytes(
        crate([{ "@type": "PropertyValue", propertyID: "https://example.test/other", value: DIGEST }]),
      ),
    ).toBeNull();
  });

  test("returns null rather than throwing on unreadable bytes", () => {
    expect(traceReferenceFromRecordBytes(new Uint8Array([0xff]))).toBeNull();
    expect(traceReferenceFromRecordBytes(new TextEncoder().encode("not json"))).toBeNull();
    expect(traceReferenceFromRecordBytes(new TextEncoder().encode("{}"))).toBeNull();
  });

  test("rejects a malformed digest value", () => {
    expect(
      traceReferenceFromRecordBytes(
        crate([
          {
            "@type": "PropertyValue",
            propertyID: TRACE_RECORD_IDENTIFIER_PROPERTY,
            value: "sha256:not-a-digest",
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("loadTraceRecord", () => {
  test("parses the stored artifact under C1's schema", async () => {
    const { buildTraceRecord } = await import("./trace.js");
    const { parseSessionFeed } = await import("./feed.js");
    const { readFile } = await import("node:fs/promises");
    const feedBytes = new Uint8Array(
      await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url)),
    );
    const built = buildTraceRecord(parseSessionFeed(feedBytes), feedBytes);
    const repository = {
      getArtifact: async () => built.bytes,
    } as unknown as Parameters<typeof loadTraceRecord>[0];
    const record = await loadTraceRecord(repository, { digest: built.digest });
    expect(record.traceId).toBe(built.traceId);
  });

  test("throws when the artifact is absent", async () => {
    const repository = {
      getArtifact: async () => null,
    } as unknown as Parameters<typeof loadTraceRecord>[0];
    await expect(loadTraceRecord(repository, { digest: DIGEST })).rejects.toThrow(/not present/u);
  });
});

const EXECUTION_DIGEST = `sha256:${"b".repeat(64)}` as const;
const TRACE_DIGEST = `sha256:${"c".repeat(64)}` as const;
const ATTESTATION_DIGEST = `sha256:${"a".repeat(64)}` as const;
const NATIVE_DIGEST = `sha256:${"d".repeat(64)}` as const;

const sampleLink = () => ({
  version: 1 as const,
  executionDigest: EXECUTION_DIGEST,
  traceDigest: TRACE_DIGEST,
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
    await writeTraceDerivationAttestationLink(paths, link);
    expect(await readTraceDerivationAttestationLink(paths, EXECUTION_DIGEST)).toEqual(link);
  });

  test("returns null when no link exists", async () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    expect(await readTraceDerivationAttestationLink(paths, EXECUTION_DIGEST)).toBeNull();
  });

  test("reads a legacy trajectoryDigest-shaped link file and normalizes it to traceDigest", async () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    await ensureOwnerOnlyDirectory(paths.derivationLinksDirectory);
    const legacyShaped = {
      version: 1,
      executionDigest: EXECUTION_DIGEST,
      // Pre-re-seal spelling (wave 7 trajectory -> trace convergence) — no `traceDigest` key.
      trajectoryDigest: TRACE_DIGEST,
      attestationDigest: ATTESTATION_DIGEST,
      nativeTraceDigest: NATIVE_DIGEST,
      derivedAt: "2026-07-30T09:00:06Z",
    };
    await writeFile(derivationLinkPath(paths, EXECUTION_DIGEST), `${JSON.stringify(legacyShaped)}\n`);

    const loaded = await readTraceDerivationAttestationLink(paths, EXECUTION_DIGEST);
    expect(loaded).toEqual(sampleLink());
    expect(loaded).not.toHaveProperty("trajectoryDigest");
  });

  test("duplicate write of the same link succeeds", async () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    const link = sampleLink();
    await writeTraceDerivationAttestationLink(paths, link);
    await expect(writeTraceDerivationAttestationLink(paths, link)).resolves.toBeUndefined();
  });

  test("rejects a mismatched rewrite", async () => {
    const paths = resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));
    await writeTraceDerivationAttestationLink(paths, sampleLink());
    await expect(
      writeTraceDerivationAttestationLink(paths, {
        ...sampleLink(),
        traceDigest: `sha256:${"e".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "capture-derivation-link-mismatch" });
  });

  test("loads attestation bytes and statement from the archive", async () => {
    const { buildTraceDerivationStatement, sealTraceDerivationAttestation, TRACE_VOCABULARY_PROFILE } =
      await import("@jinn-network/evidence-trace");
    const statement = buildTraceDerivationStatement({
      producerId: "https://spec.jinn.network/software/plugin-runtime",
      executionDigest: EXECUTION_DIGEST,
      traceDigest: TRACE_DIGEST,
      nativeTraceDigest: NATIVE_DIGEST,
      formatIri: "https://spec.jinn.network/formats/agent-session-feed/v1",
      decoderId: "agent-session-feed",
      decoderVersion: "1.0.0",
      vocabularyProfile: TRACE_VOCABULARY_PROFILE,
      timebase: "source-epoch-ns",
      linkageMode: "forward-linked",
      derivedAt: "2026-07-30T09:00:06Z",
    });
    const sealed = await sealTraceDerivationAttestation({
      statement,
      signer: async () => [{ signature: new Uint8Array([9]), keyid: "k" }],
    });
    const repository = new InMemoryEvidenceRepository();
    await repository.putArtifact(sealed.envelopeBytes);
    const link = { ...sampleLink(), attestationDigest: sealed.digest };
    const loaded = await loadTraceDerivationAttestation(repository, link);
    expect(loaded.envelopeBytes).toEqual(sealed.envelopeBytes);
    expect(loaded.statement.predicate.derivedAt).toBe("2026-07-30T09:00:06Z");
  });
});
