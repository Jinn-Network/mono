import { describe, expect, test } from "vitest";
import { sealDsseEnvelope } from "@jinn-network/trust-core";
import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_PUBLICATION_EXTENSION,
  MATRIX_ASSEMBLY_PROCEDURE_VERSION,
  REPORT_V2_RECORD_KIND,
  TRUST_AUTHORIZATION_RECORD_KIND,
  checkObservationArchive,
  checkPublicRegistrationOrder,
  parseBenchmarkAccounting,
  parseObservationArchive,
  parseSignedReportRecord,
  sealBenchmarkAccounting,
  sealObservationArchive,
  sealReport,
  withMatrixPublicationExtension,
  withRunPublicationExtension,
} from "./index.js";

const DIGEST = "a".repeat(64);
const DESCRIPTOR = { name: "sealed", digest: { sha256: DIGEST } };
const OWNER_AUTHORITY = { kind: "run-owner" as const };

const report = {
  protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
  subjects: [DESCRIPTOR],
  method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
  results: {},
  disclosures: {
    perSubject: [{
      subjectSha256: DIGEST,
      integrityTiers: { "re-derivable": 0, "attested-only": 0 },
      pinning: {
        harness: { match: 0, mismatch: 0, unverifiable: 0 },
        model: { match: 0, mismatch: 0, unverifiable: 0 },
        loadout: { match: 0, mismatch: 0, unverifiable: 0 },
        isolation: { match: 0, mismatch: 0, unverifiable: 0 },
      },
      independence: 0,
      completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" },
      attrition: { perArm: {}, asymmetryFlags: [] },
    }],
  },
  author: "did:example:publisher",
};

describe("benchmark publication record contracts", () => {
  test("preserves raw Report v1 parsing while Report v2 identifies the exact DSSE envelope", () => {
    const payload = sealReport(report);
    const envelope = sealDsseEnvelope({
      payloadType: "application/vnd.jinn.benchmarking.report.v1+json",
      payloadBytes: payload.bytes,
      signatures: [{ signature: Uint8Array.of(1), keyid: "did:example:key" }],
    });
    const parsed = parseSignedReportRecord(envelope);

    expect(REPORT_V2_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-report/v2");
    expect(parsed.payload).toEqual(report);
    expect(parsed.payloadBytes).toEqual(payload.bytes);
    expect(parsed.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("seals a deterministic observation archive and rejects incorrectly ordered streams", () => {
    const archive = {
      profile: "https://spec.jinn.network/profiles/benchmark-observation-archive/v1",
      submission: DESCRIPTOR,
      capturedThrough: { at: "2026-08-13T00:00:00Z", cursor: "0000000000000001" },
      streams: [{
        source: "https://backend.example/observations",
        subject: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
        authority: "authoritative",
        observations: [{
          specversion: "1.0",
          id: "engaged",
          source: "https://backend.example/observations",
          subject: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
          time: "2026-08-13T00:00:00Z",
          datacontenttype: "application/json",
          sequence: "0000000000000001",
          type: "network.jinn.task-execution.attempt-engaged.v1",
          data: {
            attempt: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
            task: `sha256:${DIGEST}`,
            submission: "urn:uuid:bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
            effectiveDeadline: "2026-08-14T00:00:00Z",
            source: "https://backend.example/observations",
            dispatchContext: DESCRIPTOR,
          },
        }],
        conflicts: [],
        exactEnvelopes: [DESCRIPTOR],
      }],
    };
    const sealed = sealObservationArchive(archive);
    expect(checkObservationArchive(parseObservationArchive(sealed.bytes)).status).toBe("pass");
    expect(() => sealObservationArchive({ ...archive, streams: [...archive.streams, archive.streams[0]] })).toThrow();
  });

  test("pins accounting procedure and compares same-source registration positions", () => {
    const accounting = sealBenchmarkAccounting({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      run: DESCRIPTOR,
      publisher: "did:example:publisher",
      publisherAuthority: OWNER_AUTHORITY,
      procedure: { id: "jinn.benchmarking.accounting", version: "1.0" },
      scope: { streams: [{
        role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1",
        kind: "record-discovery",
        source: { agent: "did:example:publisher", name: "benchmarks" },
        through: { sequence: "0000000000000042", entry: `sha256:${DIGEST}` },
      }] },
      publicRegistration: {
        status: "pre-dispatch",
        runBoundary: { kind: "record-discovery", source: { agent: "did:example:publisher", name: "benchmarks" }, position: { sequence: "0000000000000001", entry: `sha256:${DIGEST}` } },
        firstDispatchBoundary: { kind: "record-discovery", source: { agent: "did:example:publisher", name: "benchmarks" }, position: { sequence: "0000000000000002", entry: `sha256:${DIGEST}` } },
      },
      closeBoundary: { at: "2026-08-13T00:00:00Z" },
      cells: [],
    });

    expect(BENCHMARK_ACCOUNTING_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-accounting/v1");
    expect(checkPublicRegistrationOrder(parseBenchmarkAccounting(accounting.bytes))).toEqual({ status: "pass" });
  });

  test("freezes owner or typed delegate authority and rejects authorization effective after close", () => {
    const base = {
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      run: DESCRIPTOR,
      publisher: "did:example:delegate",
      procedure: { id: "jinn.benchmarking.accounting", version: "1.0" },
      scope: { streams: [{
        role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1",
        kind: "record-discovery",
        source: { agent: "did:example:delegate", name: "benchmarks" },
        through: { sequence: "0000000000000042", entry: `sha256:${DIGEST}` },
      }] },
      publicRegistration: { status: "post-hoc" },
      closeBoundary: { at: "2026-08-13T12:00:00Z" },
      cells: [],
    };
    const delegated = {
      kind: "authorization",
      authorization: { kind: TRUST_AUTHORIZATION_RECORD_KIND, record: DESCRIPTOR },
      effectiveBoundary: { at: "2026-08-13T11:59:59Z" },
    };

    expect(() => sealBenchmarkAccounting({ ...base, publisherAuthority: delegated })).not.toThrow();
    expect(() => sealBenchmarkAccounting({
      ...base,
      publisherAuthority: {
        ...delegated,
        authorization: { ...delegated.authorization, kind: "https://example.test/not-authorization/v1" },
      },
    })).toThrow();
    expect(() => sealBenchmarkAccounting({
      ...base,
      publisherAuthority: { ...delegated, effectiveBoundary: { at: "2026-08-13T12:00:01Z" } },
    })).toThrow();
  });

  test("rejects reversed or duplicate conflict order at both conflict and observation levels", () => {
    const observation = (id: string, sequence: string, detail: string) => ({
      specversion: "1.0",
      id,
      source: "https://backend.example/observations",
      subject: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
      time: `2026-08-13T00:00:${sequence.slice(-2)}Z`,
      datacontenttype: "application/json",
      sequence,
      type: "network.jinn.task-execution.attempt-terminal.v1",
      data: { state: "failed", detail },
    });
    const conflict = (id: string) => ({
      source: "https://backend.example/observations",
      id,
      observations: [
        observation(id, "0000000000000001", "a"),
        observation(id, "0000000000000002", "b"),
      ],
    });
    const archive = {
      profile: "https://spec.jinn.network/profiles/benchmark-observation-archive/v1",
      submission: DESCRIPTOR,
      capturedThrough: { at: "2026-08-13T00:01:00Z" },
      streams: [{
        source: "https://backend.example/observations",
        subject: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
        authority: "corroborating",
        observations: [],
        conflicts: [conflict("a"), conflict("b")],
        exactEnvelopes: [],
      }],
    };

    expect(() => sealObservationArchive(archive)).not.toThrow();
    expect(() => sealObservationArchive({
      ...archive,
      streams: [{ ...archive.streams[0]!, conflicts: [...archive.streams[0]!.conflicts].reverse() }],
    })).toThrow();
    expect(() => sealObservationArchive({
      ...archive,
      streams: [{ ...archive.streams[0]!, conflicts: [conflict("a"), conflict("a")] }],
    })).toThrow();
    expect(() => sealObservationArchive({
      ...archive,
      streams: [{
        ...archive.streams[0]!,
        conflicts: [{ ...conflict("a"), observations: [...conflict("a").observations].reverse() }],
      }],
    })).toThrow();
    expect(() => sealObservationArchive({
      ...archive,
      streams: [{
        ...archive.streams[0]!,
        conflicts: [{ ...conflict("a"), observations: [conflict("a").observations[0]!, conflict("a").observations[0]!] }],
      }],
    })).toThrow();
  });

  test("uses one namespaced extension for Run registration and Matrix accounting", () => {
    expect(BENCHMARK_PUBLICATION_EXTENSION).toBe("https://spec.jinn.network/extensions/benchmark-publication/v1");
    expect(MATRIX_ASSEMBLY_PROCEDURE_VERSION).toBe("2.0");
    expect(withRunPublicationExtension({}, { registrationArtifacts: [{ role: "https://example.test/runtime/v1", artifact: DESCRIPTOR }] })[BENCHMARK_PUBLICATION_EXTENSION]).toBeDefined();
    expect(withMatrixPublicationExtension({}, { accounting: DESCRIPTOR })[BENCHMARK_PUBLICATION_EXTENSION]).toBeDefined();
  });
});
