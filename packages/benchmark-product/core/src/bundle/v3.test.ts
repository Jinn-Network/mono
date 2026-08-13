import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  sealBenchmarkAccounting,
  sealMatrix,
  sealReport,
  withMatrixPublicationExtension,
  BENCHMARK_PUBLICATION_EXTENSION,
  REPORT_MEDIA_TYPE,
} from "@jinn-network/benchmarking-records";
import { dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { materializeBundleV3 } from "./v3-materialize.js";
import { BundleV3NativeDisclosureSchema } from "./v3-schema.js";
import { verifyBundleV3 } from "./v3-verify.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): { accountingBytes: Uint8Array; matrixBytes: Uint8Array } {
  const run = "4e65d3fbe8ad6535681b021b30785b12b6c0e3f8878859a4148b3f58b8835db0";
  const accountingBytes = sealBenchmarkAccounting({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    run: { digest: { sha256: run } },
    publisher: "did:example:publisher",
    publisherAuthority: { kind: "run-owner" },
    procedure: { id: "jinn.benchmarking.accounting", version: "1.0" },
    scope: { streams: [{
      role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1",
      kind: "record-discovery",
      source: { agent: "did:example:publisher", name: "benchmarks" },
      through: { sequence: "0000000000000042", entry: `sha256:${"a".repeat(64)}` },
    }] },
    publicRegistration: { status: "post-hoc" },
    closeBoundary: { at: "2026-08-13T00:00:00Z" },
    cells: [],
  }).bytes;
  const matrixBytes = sealMatrix(withMatrixPublicationExtension({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    run: { digest: { sha256: run } },
    closeBoundary: { at: "2026-08-13T00:00:00Z" },
    cells: [],
    exclusions: [],
    attrition: { perArm: {}, asymmetryFlags: [] },
    completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "2.0" },
  }, { accounting: { digest: { sha256: sha256(accountingBytes) } } })).bytes;
  return { accountingBytes, matrixBytes };
}

function reportedFixture(): { accountingBytes: Uint8Array; matrixBytes: Uint8Array; payloadBytes: Uint8Array; envelopeBytes: Uint8Array } {
  const { accountingBytes, matrixBytes } = fixture();
  const matrixDigest = sha256(matrixBytes);
  const disclosure = {
    publicRegistration: {
      perSubject: [{
        subjectSha256: matrixDigest,
        status: "post-hoc",
        accounting: { digest: { sha256: sha256(accountingBytes) } },
        check: { status: "pass" },
      }],
    },
  };
  const payloadBytes = sealReport({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    subjects: [{ digest: { sha256: matrixDigest } }],
    method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
    results: {},
    disclosures: { perSubject: [{
      subjectSha256: matrixDigest,
      integrityTiers: { "re-derivable": 0, "attested-only": 0 },
      pinning: { harness: { match: 0, mismatch: 0, unverifiable: 0 }, model: { match: 0, mismatch: 0, unverifiable: 0 }, loadout: { match: 0, mismatch: 0, unverifiable: 0 }, isolation: { match: 0, mismatch: 0, unverifiable: 0 } },
      independence: 0,
      completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" },
      attrition: { perArm: {}, asymmetryFlags: [] },
    }] },
    author: "did:example:publisher",
    [BENCHMARK_PUBLICATION_EXTENSION]: disclosure,
  }).bytes;
  const keys = generateKeyPairSync("ed25519");
  const signature = sign(null, Buffer.from(dssePreAuthEncoding(REPORT_MEDIA_TYPE, payloadBytes)), keys.privateKey);
  const envelopeBytes = sealDsseEnvelope({
    payloadBytes,
    payloadType: REPORT_MEDIA_TYPE,
    signatures: [{ keyid: "did:example:publisher", signature: new Uint8Array(signature) }],
  });
  return { accountingBytes, matrixBytes, payloadBytes, envelopeBytes };
}

describe("portable benchmark bundle v3", () => {
  test("models every native disclosure state and reserves a new identity for scrub derivation", () => {
    const base = { cellKey: `${"a".repeat(64)}/arm/1`, dispatch: 1, ordinal: 1, role: "https://example.test/log" };
    expect(BundleV3NativeDisclosureSchema.safeParse({
      ...base, state: "public", artifact: { sha256: "b".repeat(64) }, path: `native/${"b".repeat(64)}.bin`,
    }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({
      ...base, state: "digest-only", artifact: { sha256: "b".repeat(64) }, reason: "consent withheld",
    }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({ ...base, state: "source-absent", reason: "not produced" }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({ ...base, state: "collection-failed", reason: "collector unavailable" }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({
      ...base, state: "scrub-derived", source: { sha256: "b".repeat(64) }, artifact: { sha256: "c".repeat(64) }, path: `native/${"c".repeat(64)}.bin`,
      derivation: { procedure: "redact", version: "1", responsible: "did:example:publisher", producedAt: "2026-08-13T00:00:00Z" },
    }).success).toBe(true);
  });

  test("materializes and verifies an accounting-only static/human bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const input = fixture();
      const bundleDir = join(root, "bundle");
      const materialized = materializeBundleV3({
        bundleDir,
        ...input,
        humanFiles: { "human/README.txt": new TextEncoder().encode("accounting only\n") },
      });
      expect(verifyBundleV3(bundleDir)).toMatchObject({
        identity: materialized.identity,
        accountingSha256: sha256(input.accountingBytes),
        matrixSha256: sha256(input.matrixBytes),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializes and verifies an optional signed Report v2 closure", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const input = reportedFixture();
      const bundleDir = join(root, "bundle");
      const materialized = materializeBundleV3({
        bundleDir,
        accountingBytes: input.accountingBytes,
        matrixBytes: input.matrixBytes,
        report: { payloadBytes: input.payloadBytes, envelopeBytes: input.envelopeBytes },
      });
      expect(verifyBundleV3(bundleDir, { announced: {
        accountingBytes: input.accountingBytes,
        matrixBytes: input.matrixBytes,
        reportEnvelopeBytes: input.envelopeBytes,
      } })).toMatchObject({
        identity: materialized.identity,
        reportRecordSha256: sha256(input.envelopeBytes),
      });
      expect(() => verifyBundleV3(bundleDir, { announced: { matrixBytes: new TextEncoder().encode("substitution") } }))
        .toThrow(/Matrix bytes differ from announced/i);
      expect(() => verifyBundleV3(bundleDir, { announced: { reportEnvelopeBytes: new TextEncoder().encode("substitution") } }))
        .toThrow(/Report envelope bytes differ from announced/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects accounting/matrix and announced-byte substitution", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const input = fixture();
      expect(() => materializeBundleV3({
        bundleDir: join(root, "mismatch"),
        accountingBytes: input.accountingBytes,
        matrixBytes: new Uint8Array(input.matrixBytes.map((value, index) => index === 0 ? value ^ 1 : value)),
      })).toThrow(/schema|Matrix|record/i);
      const bundleDir = join(root, "bundle");
      materializeBundleV3({ bundleDir, ...input });
      expect(() => verifyBundleV3(bundleDir, { announced: { accountingBytes: new TextEncoder().encode("not announced") } }))
        .toThrow(/announced/i);
      // Manifest auth is an earlier boundary than semantics; changing bundled bytes is rejected.
      writeFileSync(join(bundleDir, "records", "matrix.json"), readFileSync(join(bundleDir, "records", "accounting.json")));
      expect(() => verifyBundleV3(bundleDir)).toThrow(/length mismatch|digest mismatch/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
