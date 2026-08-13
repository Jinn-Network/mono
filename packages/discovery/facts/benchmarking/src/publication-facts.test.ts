import { readFile } from "node:fs/promises";

import {
  BENCHMARK_ACCOUNTING_MEDIA_TYPE,
  REPORT_MEDIA_TYPE,
  SIGNED_REPORT_MEDIA_TYPE,
  loadGoldenBytes,
  parseSignedReportRecord,
  sealBenchmarkAccounting,
} from "@jinn-network/benchmarking-records";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type { ReferencedBytes } from "@jinn-network/record-discovery-protocol";
import { DSSE_PAYLOAD_TYPE, sealDsseEnvelope } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  REPORT_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
} from "./identifiers.js";
import {
  benchmarkAccountingRecompute,
  reportRecompute,
  signedReportRecompute,
} from "./recompute.js";

const encoder = new TextEncoder();

async function localFixture(relativePath: string): Promise<Uint8Array> {
  // Git text fixtures end with LF; the golden record bytes themselves do not.
  const text = await readFile(new URL(`../fixtures/${relativePath}`, import.meta.url), "utf8");
  return encoder.encode(text.endsWith("\n") ? text.slice(0, -1) : text);
}

function refsFrom(entries: ReadonlyMap<string, Uint8Array>): ReferencedBytes {
  return { async "fetch"(digest) { return entries.get(digest); } };
}

const noReferences: ReferencedBytes = { async "fetch"() { return undefined; } };

function validAuthorizationBytes(): Uint8Array {
  return sealDsseEnvelope({
    payloadType: DSSE_PAYLOAD_TYPE,
    payloadBytes: encoder.encode(JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "run", digest: { sha256: "b".repeat(64) } }],
      predicateType: "https://spec.jinn.network/trust/authorization/v1",
      predicate: {
        issuer: "did:example:publisher",
        capabilities: ["benchmark-accounting:publish"],
        expiry: "2026-08-14T00:00:00Z",
        nonce: "publication-authority",
      },
    })),
    signatures: [{ signature: Uint8Array.of(1), keyid: "did:example:key" }],
  });
}

describe("benchmark publication facts", () => {
  it("preserves the legacy raw Report v1 fixture and recomputation unchanged", async () => {
    const bytes = await localFixture("report-v1/legacy-raw-payload.json");
    expect(await reportRecompute(bytes, noReferences)).toEqual({
      methodId: "jinn.benchmarking.method/wilson",
      methodVersion: "1",
      author: "urn:uuid:66666666-6666-5666-8666-666666666666",
    });
    expect(reportRecompute).toBeDefined();
    expect(REPORT_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-report/v1");
  });

  it("derives signed Report v2 facts from the exact DSSE envelope and exact embedded payload", async () => {
    const envelope = await localFixture("report-v2/valid-envelope.json");
    const parsed = parseSignedReportRecord(envelope);

    expect(await signedReportRecompute(envelope, noReferences)).toEqual({
      reportRecordDigest: recordDigest(envelope),
      reportPayloadDigest: recordDigest(parsed.payloadBytes),
      recordMediaType: SIGNED_REPORT_MEDIA_TYPE,
      payloadMediaType: REPORT_MEDIA_TYPE,
      methodId: "jinn.benchmarking.method/wilson",
      methodVersion: "1",
      author: "urn:uuid:66666666-6666-5666-8666-666666666666",
    });
    expect(REPORT_V2_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-report/v2");
  });

  it("fails closed for Report v2 wrong media, wrong payload, and a raw v1 payload under the v2 kind", async () => {
    const wrongMedia = await localFixture("report-v2/wrong-media-envelope.json");
    const wrongPayload = await localFixture("report-v2/wrong-payload-envelope.json");
    const rawV1 = await localFixture("report-v2/raw-v1-under-v2-kind.json");

    await expect(signedReportRecompute(wrongMedia, noReferences)).resolves.toEqual({});
    await expect(signedReportRecompute(wrongPayload, noReferences)).resolves.toEqual({});
    await expect(signedReportRecompute(rawV1, noReferences)).resolves.toEqual({});
  });

  it("derives BenchmarkAccounting declaration facts without asserting authorization trust", async () => {
    const run = await loadGoldenBytes("run", "minimal");
    const authorizationBytes = validAuthorizationBytes();
    const runDigest = recordDigest(run);
    const authorizationDigest = recordDigest(authorizationBytes);
    const sealed = sealBenchmarkAccounting({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      run: { name: "run", digest: { sha256: runDigest.slice("sha256:".length) } },
      publisher: "did:example:publisher",
      publisherAuthority: {
        kind: "authorization",
        authorization: {
          kind: "https://spec.jinn.network/records/authorization/v1",
          record: { name: "authorization", digest: { sha256: authorizationDigest.slice("sha256:".length) } },
        },
        effectiveBoundary: { at: "2026-08-12T23:59:59Z" },
      },
      procedure: { id: "jinn.benchmarking.accounting", version: "1.0" },
      scope: { streams: [
        {
          role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1",
          kind: "record-discovery",
          source: { agent: "did:example:publisher", name: "benchmarks" },
          through: { sequence: "0000000000000042", entry: authorizationDigest },
        },
        {
          role: "https://spec.jinn.network/roles/benchmark-substrate-dispatches/v1",
          kind: "substrate",
          profile: "https://example.test/profiles/substrate/v1",
          authority: "eip155:1:0x1234",
          through: { blockHash: "0xabc", blockNumber: 7 },
        },
      ] },
      publicRegistration: { status: "post-hoc" },
      closeBoundary: {
        at: "2026-08-13T00:00:00Z",
        anchor: { chain: "eip155:1", blockNumber: 1, blockHash: "0xabc" },
      },
      cells: [{ cellKey: `${"a".repeat(64)}/solo/1`, dispatches: [{
        index: 1,
        submission: {
          kind: "https://spec.jinn.network/records/task-submission/v1",
          record: { name: "submission", digest: { sha256: "a".repeat(64) } },
        },
        evidence: [],
        evaluations: [],
        correlations: [],
        nativeArtifacts: [],
      }] }],
    });

    expect(await benchmarkAccountingRecompute(
      sealed.bytes,
      refsFrom(new Map([[runDigest, run], [authorizationDigest, authorizationBytes]])),
    )).toEqual({
      accountingDigest: recordDigest(sealed.bytes),
      recordMediaType: BENCHMARK_ACCOUNTING_MEDIA_TYPE,
      runDigest,
      publisher: "did:example:publisher",
      procedureId: "jinn.benchmarking.accounting",
      procedureVersion: "1.0",
      closeAt: "2026-08-13T00:00:00Z",
      closeAnchorChain: "eip155:1",
      closeAnchorBlockNumber: 1,
      closeAnchorBlockHash: "0xabc",
      scopeStreamCount: 2,
      scopeStreams: [
        `{"kind":"record-discovery","role":"https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1","source":{"agent":"did:example:publisher","name":"benchmarks"},"through":{"entry":"${authorizationDigest}","sequence":"0000000000000042"}}`,
        "{\"authority\":\"eip155:1:0x1234\",\"kind\":\"substrate\",\"profile\":\"https://example.test/profiles/substrate/v1\",\"role\":\"https://spec.jinn.network/roles/benchmark-substrate-dispatches/v1\",\"through\":{\"blockHash\":\"0xabc\",\"blockNumber\":7}}",
      ],
      publicRegistrationStatus: "post-hoc",
      publisherAuthorityKind: "authorization",
      publisherAuthorizationDigest: authorizationDigest,
      cellCount: 1,
      dispatchCount: 1,
    });
    expect(BENCHMARK_ACCOUNTING_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-accounting/v1");
  });

  it("fails closed only the unavailable Accounting reference edges, retaining native declarations", async () => {
    const bytes = await localFixture("benchmark-accounting/valid.json");
    const facts = await benchmarkAccountingRecompute(bytes, noReferences);

    expect(facts).toMatchObject({
      accountingDigest: recordDigest(bytes),
      recordMediaType: BENCHMARK_ACCOUNTING_MEDIA_TYPE,
      publisher: "did:example:publisher",
      procedureId: "jinn.benchmarking.accounting",
      procedureVersion: "1.0",
      publicRegistrationStatus: "post-hoc",
      publisherAuthorityKind: "authorization",
      scopeStreamCount: 1,
      scopeStreams: [
        "{\"kind\":\"record-discovery\",\"role\":\"https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1\",\"source\":{\"agent\":\"did:example:publisher\",\"name\":\"benchmarks\"},\"through\":{\"entry\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"sequence\":\"0000000000000042\"}}",
      ],
      cellCount: 0,
      dispatchCount: 0,
    });
    expect(facts).not.toHaveProperty("runDigest");
    expect(facts).not.toHaveProperty("publisherAuthorizationDigest");
  });

  it("omits the authorization edge for malformed or wrong-kind bytes while retaining Accounting declarations", async () => {
    const run = await loadGoldenBytes("run", "minimal");
    const runDigest = recordDigest(run);
    const malformed = encoder.encode("{}");
    const wrongKind = await localFixture("report-v2/valid-envelope.json");

    for (const authorizationBytes of [malformed, wrongKind]) {
      const authorizationDigest = recordDigest(authorizationBytes);
      const sealed = sealBenchmarkAccounting({
        protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
        run: { name: "run", digest: { sha256: runDigest.slice("sha256:".length) } },
        publisher: "did:example:publisher",
        publisherAuthority: {
          kind: "authorization",
          authorization: {
            kind: "https://spec.jinn.network/records/authorization/v1",
            record: { name: "authorization", digest: { sha256: authorizationDigest.slice("sha256:".length) } },
          },
          effectiveBoundary: { at: "2026-08-12T23:59:59Z" },
        },
        procedure: { id: "jinn.benchmarking.accounting", version: "1.0" },
        scope: { streams: [{
          role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1",
          kind: "record-discovery",
          source: { agent: "did:example:publisher", name: "benchmarks" },
          through: { sequence: "0000000000000042", entry: authorizationDigest },
        }] },
        publicRegistration: { status: "post-hoc" },
        closeBoundary: { at: "2026-08-13T00:00:00Z" },
        cells: [],
      });
      const facts = await benchmarkAccountingRecompute(
        sealed.bytes,
        refsFrom(new Map([[runDigest, run], [authorizationDigest, authorizationBytes]])),
      );
      expect(facts).toMatchObject({
        accountingDigest: recordDigest(sealed.bytes),
        runDigest,
        publisherAuthorityKind: "authorization",
      });
      expect(facts).not.toHaveProperty("publisherAuthorizationDigest");
    }
  });
});
