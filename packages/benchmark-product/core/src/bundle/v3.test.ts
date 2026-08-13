import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { canonicalJsonBytes, dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { buildBundleManifest } from "./manifest.js";
import { assertBundleV3Input, materializeBundleV3 } from "./v3-materialize.js";
import { BundleV3NativeDisclosureSchema } from "./v3-schema.js";
import { verifyBundleV3 } from "./v3-verify.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(matrixCloseBoundary: {
  readonly at: string;
  readonly anchor?: { readonly chain: string; readonly blockNumber: number; readonly blockHash: string };
} = { at: "2026-08-13T00:00:00Z" }): { accountingBytes: Uint8Array; matrixBytes: Uint8Array } {
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
    closeBoundary: matrixCloseBoundary,
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

function nativeFixture(availability: "public" | "digest-only" | "collection-failed", nativeArtifactCount = 1) {
  const taskDigest = "a".repeat(64);
  const run = "4e65d3fbe8ad6535681b021b30785b12b6c0e3f8878859a4148b3f58b8835db0";
  const cellKey = `${taskDigest}/arm/1`;
  const nativeBytes = new TextEncoder().encode("shared native log\n");
  const source = { name: "raw.log", mediaType: "text/plain", digest: { sha256: sha256(nativeBytes) } };
  const accountingBytes = sealBenchmarkAccounting({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    run: { digest: { sha256: run } }, publisher: "did:example:publisher", publisherAuthority: { kind: "run-owner" },
    procedure: { id: "jinn.benchmarking.accounting", version: "1.0" },
    scope: { streams: [{ role: "https://spec.jinn.network/roles/dispatch/v1", kind: "record-discovery", source: { agent: "did:example:publisher", name: "benchmarks" }, through: { sequence: "0000000000000001", entry: `sha256:${"c".repeat(64)}` } }] },
    publicRegistration: { status: "post-hoc" }, closeBoundary: { at: "2026-08-13T00:00:00Z" },
    cells: [{ cellKey, dispatches: [{
      index: 1,
      submission: { kind: "https://spec.jinn.network/records/submission/v1", record: { digest: { sha256: "d".repeat(64) } } },
      delivery: { kind: "https://spec.jinn.network/records/delivery/v1", record: { digest: { sha256: "e".repeat(64) } } },
      evidence: [], evaluations: [], correlations: [],
      nativeArtifacts: Array.from({ length: nativeArtifactCount }, () => ({
        role: "https://example.test/log", availability, artifact: source, reason: "source retained privately",
      })),
    }] }],
  }).bytes;
  const matrixBytes = sealMatrix(withMatrixPublicationExtension({
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1", run: { digest: { sha256: run } }, closeBoundary: { at: "2026-08-13T00:00:00Z" },
    cells: [{ cellKey, taskDigest, armId: "arm", replicate: 1, dispatches: 1, accounted: 1, submission: `sha256:${"d".repeat(64)}`, delivery: `sha256:${"e".repeat(64)}`, verdicts: [], validVerdicts: [], outcome: "unjudged", verification: { harness: "unverifiable", model: "unverifiable", loadout: "unverifiable", isolation: "unverifiable", checksFailed: [] }, integrityTier: "attested-only" }],
    exclusions: [],
    attrition: { perArm: { arm: { expected: 1, judged: 0, unjudged: 1, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0 } }, asymmetryFlags: [] },
    completeness: { expected: 1, judged: 0, floor: "1", runOutcome: "partial" }, assembly: { procedure: "jinn.benchmarking.assembly", version: "2.0" },
  }, { accounting: { digest: { sha256: sha256(accountingBytes) } } })).bytes;
  return { accountingBytes, matrixBytes, cellKey, source, nativeBytes };
}

function rewriteV3Index(bundleDir: string, mutate: (index: Record<string, any>) => void): void {
  const indexPath = join(bundleDir, "bundle-v3.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, any>;
  mutate(index);
  writeFileSync(indexPath, canonicalJsonBytes(index));
  const oldManifest = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")) as { files: Array<{ path: string }> };
  const rebuilt = buildBundleManifest(bundleDir, oldManifest.files.map((file) => file.path), { format: "benchmark-product-public-bundle/3" });
  writeFileSync(join(bundleDir, "bundle.json"), rebuilt.bytes);
}

describe("portable benchmark bundle v3", () => {
  test("models every native disclosure state and reserves a new identity for scrub derivation", () => {
    const base = { cellKey: `${"a".repeat(64)}/arm/1`, dispatch: 1, ordinal: 1, role: "https://example.test/log" };
    expect(BundleV3NativeDisclosureSchema.safeParse({
      ...base, state: "public", artifact: { digest: { sha256: "b".repeat(64) } }, path: `native/${"b".repeat(64)}.bin`,
    }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({
      ...base, state: "digest-only", artifact: { digest: { sha256: "b".repeat(64) } }, reason: "consent withheld",
    }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({ ...base, state: "source-absent", reason: "not produced" }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({ ...base, state: "collection-failed", reason: "collector unavailable" }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({
      ...base, state: "scrub-derived", source: { digest: { sha256: "b".repeat(64) } }, artifact: { digest: { sha256: "c".repeat(64) } }, path: `native/${"c".repeat(64)}.bin`,
      derivation: { procedure: "redact", version: "1", responsible: "did:example:publisher", producedAt: "2026-08-13T00:00:00Z" },
    }).success).toBe(true);
    expect(BundleV3NativeDisclosureSchema.safeParse({
      ...base, state: "scrub-derived", artifact: { digest: { sha256: "c".repeat(64) } }, path: `native/${"c".repeat(64)}.bin`,
      derivation: { procedure: "redact", version: "1", responsible: "did:example:publisher", producedAt: "2026-08-13T00:00:00Z" },
    }).success).toBe(false);
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

  test.each([
    ["close time", { at: "2026-08-13T00:00:01Z" }],
    ["close anchor", {
      at: "2026-08-13T00:00:00Z",
      anchor: { chain: "eip155:1", blockNumber: 42, blockHash: `0x${"a".repeat(64)}` },
    }],
  ])("rejects an otherwise-valid Matrix whose %s differs from BenchmarkAccounting", (_name, closeBoundary) => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const mismatched = fixture(closeBoundary);
      expect(() => assertBundleV3Input({ bundleDir: "unused", ...mismatched })).toThrow(/closeBoundary must match exactly/i);

      const bundleDir = join(root, "bundle");
      materializeBundleV3({ bundleDir, ...fixture() });
      writeFileSync(join(bundleDir, "records", "matrix.json"), mismatched.matrixBytes);
      rewriteV3Index(bundleDir, (index) => {
        index.matrix.sha256 = sha256(mismatched.matrixBytes);
      });
      expect(() => verifyBundleV3(bundleDir)).toThrow(/closeBoundary must match exactly/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a manifest-authenticated source receipt whose inline position was altered", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const bundleDir = join(root, "bundle");
      materializeBundleV3({ bundleDir, ...fixture() });
      rewriteV3Index(bundleDir, (index) => {
        index.sourceReceipts[0].position.position.sequence = "0000000000000041";
      });
      expect(() => verifyBundleV3(bundleDir)).toThrow(/source receipt bytes or position/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exact-binds scrub provenance and every retained Accounting descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const input = nativeFixture("digest-only");
      const scrubbed = new TextEncoder().encode("scrubbed log\n");
      const derived = { name: "public.log", mediaType: "text/plain", digest: { sha256: sha256(scrubbed) } };
      const disclosure = {
        cellKey: input.cellKey, dispatch: 1, ordinal: 1, role: "https://example.test/log", state: "scrub-derived" as const,
        source: input.source, artifact: derived, path: `native/${derived.digest.sha256}.bin`,
        derivation: { procedure: "https://example.test/scrub", version: "1", responsible: "did:example:publisher", producedAt: "2026-08-13T00:00:00Z" },
      };
      const bundleDir = join(root, "bundle");
      materializeBundleV3({ bundleDir, accountingBytes: input.accountingBytes, matrixBytes: input.matrixBytes, nativeArtifacts: [{ disclosure, bytes: scrubbed }] });
      expect(verifyBundleV3(bundleDir).checks).toContain("native-disclosures");

      expect(() => assertBundleV3Input({
        bundleDir: "unused", accountingBytes: input.accountingBytes, matrixBytes: input.matrixBytes,
        nativeArtifacts: [{ disclosure: { ...disclosure, source: { ...input.source, name: "other.log" } }, bytes: scrubbed }],
      })).toThrow(/source descriptor differs/i);
      expect(() => assertBundleV3Input({
        bundleDir: "unused", accountingBytes: input.accountingBytes, matrixBytes: input.matrixBytes,
        nativeArtifacts: [{ disclosure: { ...disclosure, artifact: input.source, path: `native/${input.source.digest.sha256}.bin` }, bytes: new Uint8Array() }],
      })).toThrow(/new digest|declared digest/i);

      const failed = nativeFixture("collection-failed");
      expect(() => assertBundleV3Input({
        bundleDir: "unused", accountingBytes: failed.accountingBytes, matrixBytes: failed.matrixBytes,
        nativeArtifacts: [{ disclosure: { cellKey: failed.cellKey, dispatch: 1, ordinal: 1, role: "https://example.test/log", state: "collection-failed", reason: "collector unavailable" } }],
      })).toThrow(/descriptor differs/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("content-dedupes repeated public native artifacts and emits one manifest path", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const input = nativeFixture("public", 2);
      const path = `native/${input.source.digest.sha256}.bin`;
      const nativeArtifacts = [1, 2].map((ordinal) => ({
        disclosure: {
          cellKey: input.cellKey, dispatch: 1, ordinal, role: "https://example.test/log", state: "public" as const,
          artifact: input.source, path,
        },
        bytes: input.nativeBytes,
      }));
      const bundleDir = join(root, "bundle");
      materializeBundleV3({
        bundleDir, accountingBytes: input.accountingBytes, matrixBytes: input.matrixBytes, nativeArtifacts,
      });
      expect(verifyBundleV3(bundleDir).checks).toContain("native-disclosures");
      const manifest = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")) as { files: Array<{ path: string }> };
      const paths = manifest.files.map((file) => file.path);
      expect(paths.filter((candidate) => candidate === path)).toHaveLength(1);
      expect(new Set(paths).size).toBe(paths.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses conflicting bytes for a repeated staged artifact path and cleans staging", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const input = nativeFixture("public", 2);
      const path = `native/${input.source.digest.sha256}.bin`;
      const nativeArtifacts = [1, 2].map((ordinal) => ({
        disclosure: {
          cellKey: input.cellKey, dispatch: 1, ordinal, role: "https://example.test/log", state: "public" as const,
          artifact: input.source, path,
        },
        bytes: input.nativeBytes,
      }));
      const bundleDir = join(root, "bundle");
      expect(() => materializeBundleV3({
        bundleDir, accountingBytes: input.accountingBytes, matrixBytes: input.matrixBytes, nativeArtifacts,
      }, {
        beforeStagedWrite: (candidate, occurrence) => {
          if (candidate === path && occurrence === 2) input.nativeBytes[0] = input.nativeBytes[0]! ^ 1;
        },
      })).toThrow(/reused for conflicting bytes/i);
      expect(existsSync(bundleDir)).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith("bundle.tmp-"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleans a fully durable staging tree when final publication fails", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const bundleDir = join(root, "bundle");
      expect(() => materializeBundleV3({ bundleDir, ...fixture() }, { beforeRename: () => { throw new Error("injected rename failure"); } }))
        .toThrow(/injected rename failure/);
      expect(existsSync(bundleDir)).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith("bundle.tmp-"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reconciles an identical target that appears at the final rename boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const bundleDir = join(root, "bundle");
      const input = fixture();
      const outer = materializeBundleV3({ bundleDir, ...input }, {
        beforeRename: () => { materializeBundleV3({ bundleDir, ...input }); },
      });
      expect(verifyBundleV3(bundleDir).identity).toBe(outer.identity);
      expect(readdirSync(root).filter((name) => name.startsWith("bundle.tmp-"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses and cleans staging when a different target appears at the final rename boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "bp-pub-v3-"));
    try {
      const bundleDir = join(root, "bundle");
      const input = fixture();
      let occupyingIdentity = "";
      expect(() => materializeBundleV3({ bundleDir, ...input }, {
        beforeRename: () => {
          occupyingIdentity = materializeBundleV3({
            bundleDir,
            ...input,
            humanFiles: { "human/race.txt": new TextEncoder().encode("occupying bytes\n") },
          }).identity;
        },
      })).toThrow(/appeared with different bytes/i);
      expect(verifyBundleV3(bundleDir).identity).toBe(occupyingIdentity);
      expect(readdirSync(root).filter((name) => name.startsWith("bundle.tmp-"))).toEqual([]);
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
