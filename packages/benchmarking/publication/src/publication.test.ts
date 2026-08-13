import { describe, expect, test } from "vitest";
import {
  BENCHMARK_ACCOUNTING_MEDIA_TYPE, BENCHMARK_ACCOUNTING_RECORD_KIND, BENCHMARK_PUBLICATION_EXTENSION,
  BENCHMARKING_PROTOCOL, MATRIX_MEDIA_TYPE, MATRIX_RECORD_KIND, REPORT_MEDIA_TYPE, REPORT_V2_RECORD_KIND,
  RUN_MEDIA_TYPE, RUN_RECORD_KIND, SIGNED_REPORT_MEDIA_TYPE, cellIdempotencyKey, sealBenchmarkAccounting,
  sealMatrix, sealRecord, sealReport, sealRun, serializeCanonicalJson, withMatrixPublicationExtension,
  withRunPublicationExtension,
} from "@jinn-network/benchmarking-records";
import { sealSubmission } from "@jinn-network/task-execution-protocol";
import { sha256 } from "@jinn-network/record-publication";
import { buildBenchmarkAccounting, buildBenchmarkPublicationPlan, buildObservationArchive, verifyBenchmarkAccounting } from "./index.js";
import type { BenchmarkPublicationPlanInput, PublicationRecordInput } from "./types.js";

const hex = "a".repeat(64);
const cell = `${hex}/arm/1`;
const runReference = { name: "run", digest: { sha256: hex } };
const scope = [{ role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1", kind: "record-discovery" as const, source: { agent: "did:example:publisher", name: "benchmarks" }, through: { sequence: "0000000000000042", entry: `sha256:${hex}` } }];

function submissionFor(index: number, nonce = `nonce-${index}`) {
  const bytes = sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1", submission: `urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaa${index}`,
    task: { digest: { sha256: hex } }, requester: "did:example:publisher", idempotencyKey: cellIdempotencyKey(`sha256:${hex}`, cell, index), nonce,
    deadline: "2026-08-14T00:00:00Z", attempts: { maxTotal: 1, maxConcurrent: 1 },
    annotations: { run: `sha256:${hex}`, cellKey: cell, armId: "arm" },
  });
  return { bytes, reference: { kind: "https://spec.jinn.network/records/submission/v1", record: { name: "submission", digest: { sha256: sha256(bytes).slice(7) } } } };
}
function accounting(dispatches = [{ cellKey: cell, index: 1, submission: submissionFor(1).reference, submissionBytes: submissionFor(1).bytes }]) {
  return buildBenchmarkAccounting({ run: runReference, runOwner: "did:example:publisher", publisher: "did:example:publisher", publisherAuthority: { kind: "run-owner" }, scope,
    publicRegistration: { status: "post-hoc" }, closeBoundary: { at: "2026-08-13T00:00:00Z" }, expectedCellKeys: [cell], dispatches,
  });
}
const observation = (id: string, detail = "same") => ({ specversion: "1.0" as const, id, source: "https://runtime.example/stream", subject: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa", time: "2026-08-13T00:00:00Z", datacontenttype: "application/json" as const, sequence: "0000000000000002", type: "network.jinn.task-execution.attempt-terminal.v1" as const, data: { state: "failed" as const, detail } });

function signedEnvelope(payloadBytes: Uint8Array): Uint8Array {
  return serializeCanonicalJson({ payloadType: REPORT_MEDIA_TYPE, payload: Buffer.from(payloadBytes).toString("base64"), signatures: [{ keyid: "did:example:key", sig: "AQ==" }] });
}
function ownerRecord(id: string, kind: string, mediaType: string, sealed: { bytes: Uint8Array; digest: `sha256:${string}` }, at: string): PublicationRecordInput {
  return { id, kind, mediaType, bytes: sealed.bytes, digest: sealed.digest, authority: { mode: "owner" }, announcementTimestamp: at };
}
function publicationFixture(options: {
  matrixVersion?: "1.0" | "2.0";
  matrixCloseAt?: string;
  matrixRunDigest?: string;
  includeArtifact?: boolean;
  report?: boolean;
  reportMatrixDigest?: string;
  publicRegistration?: "post-hoc" | "pre-dispatch-fail";
  reportCheck?: { status: "pass" } | { status: "fail"; detail: string };
} = {}) {
  const artifact = sealRecord({ runtime: "v1" });
  const runSealed = sealRun(withRunPublicationExtension({
    protocol: BENCHMARKING_PROTOCOL, benchmark: { digest: { sha256: "b".repeat(64) } }, owner: "did:example:publisher",
    arms: [{ armId: "arm", pinning: {} }], replicates: 1, policy: { completenessFloor: "1", cellWindow: 1, replacement: { allowed: true }, independence: "disclosed", evaluation: {}, submissionBaseline: {} }, closeAt: "2026-08-13T00:00:00Z",
  }, { registrationArtifacts: [{ role: "https://runtime.example/selection/v1", artifact: { name: "runtime", digest: { sha256: artifact.digest.slice(7) } } }] }));
  const publicRegistration = options.publicRegistration === "pre-dispatch-fail" ? {
    status: "pre-dispatch" as const,
    runBoundary: { kind: "record-discovery" as const, source: { agent: "did:example:publisher", name: "benchmarks" }, position: { sequence: "0000000000000002", entry: `sha256:${hex}` as const } },
    firstDispatchBoundary: { kind: "record-discovery" as const, source: { agent: "did:example:publisher", name: "benchmarks" }, position: { sequence: "0000000000000001", entry: `sha256:${hex}` as const } },
  } : { status: "post-hoc" as const };
  const accountingSealed = sealBenchmarkAccounting({ protocol: BENCHMARKING_PROTOCOL, run: { digest: { sha256: runSealed.digest.slice(7) } }, publisher: "did:example:publisher", publisherAuthority: { kind: "run-owner" }, procedure: { id: "jinn.benchmarking.accounting", version: "1.0" }, scope: { streams: scope }, publicRegistration, closeBoundary: { at: "2026-08-13T00:00:00Z" }, cells: [] });
  const matrixBase = { protocol: BENCHMARKING_PROTOCOL, run: { digest: { sha256: options.matrixRunDigest ?? runSealed.digest.slice(7) } }, closeBoundary: { at: options.matrixCloseAt ?? "2026-08-13T00:00:00Z" }, cells: [], exclusions: [], attrition: { perArm: {}, asymmetryFlags: [] }, completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" }, assembly: { procedure: "jinn.benchmarking.assembly", version: options.matrixVersion ?? "2.0" } };
  const accountingReference = { name: "accounting", digest: { sha256: accountingSealed.digest.slice(7) } };
  const matrixSealed = sealMatrix(options.matrixVersion === "1.0" ? matrixBase : withMatrixPublicationExtension(matrixBase, { accounting: accountingReference }));
  const delivery = sealRecord({ delivery: true });
  const registration = [
    ...(options.includeArtifact === false ? [] : [{ id: "runtime", role: "https://runtime.example/selection/v1", digest: artifact.digest, bytes: artifact.bytes, mediaType: "application/json" }]),
    ownerRecord("run", RUN_RECORD_KIND, RUN_MEDIA_TYPE, runSealed, "2026-08-13T00:00:00Z"),
  ];
  let input: BenchmarkPublicationPlanInput = { id: "publication-1", runId: "run", registration, accounting: {
    members: [{ id: "delivery", kind: "https://spec.jinn.network/records/delivery/v1", digest: delivery.digest, bytes: delivery.bytes, mediaType: "application/json", authority: { mode: "origin-reference", origin: { source: { agent: "did:operator", name: "deliveries" }, sequence: "0000000000000001", entryDigest: delivery.digest }, mirror: true } }],
    accounting: ownerRecord("accounting", BENCHMARK_ACCOUNTING_RECORD_KIND, BENCHMARK_ACCOUNTING_MEDIA_TYPE, accountingSealed, "2026-08-13T00:01:00Z"),
    matrix: ownerRecord("matrix", MATRIX_RECORD_KIND, MATRIX_MEDIA_TYPE, matrixSealed, "2026-08-13T00:02:00Z"),
  } };
  if (options.report) {
    const matrixDigest = options.reportMatrixDigest ?? matrixSealed.digest.slice(7);
    const derivedCheck = publicRegistration.status === "pre-dispatch"
      ? { status: "fail" as const, detail: "Run source position must precede the first dispatch source position" }
      : { status: "pass" as const };
    const payload = sealReport({ protocol: BENCHMARKING_PROTOCOL, subjects: [{ digest: { sha256: matrixDigest } }], method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} }, results: {}, disclosures: { perSubject: [{ subjectSha256: matrixDigest, integrityTiers: { "re-derivable": 0, "attested-only": 0 }, pinning: { harness: { match: 0, mismatch: 0, unverifiable: 0 }, model: { match: 0, mismatch: 0, unverifiable: 0 }, loadout: { match: 0, mismatch: 0, unverifiable: 0 }, isolation: { match: 0, mismatch: 0, unverifiable: 0 } }, independence: 0, completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" }, attrition: { perArm: {}, asymmetryFlags: [] } }] }, author: "did:example:publisher", [BENCHMARK_PUBLICATION_EXTENSION]: { publicRegistration: { perSubject: [{ subjectSha256: matrixDigest, status: publicRegistration.status, accounting: accountingReference, check: options.reportCheck ?? derivedCheck }] } } });
    const envelope = signedEnvelope(payload.bytes); input = { ...input, report: { record: { id: "report", kind: REPORT_V2_RECORD_KIND, digest: sha256(envelope), bytes: envelope, mediaType: SIGNED_REPORT_MEDIA_TYPE, authority: { mode: "owner" }, announcementTimestamp: "2026-08-13T00:03:00Z" } } };
  }
  return { input, runSealed, accountingSealed, matrixSealed };
}

describe("benchmark publication", () => {
  test("deduplicates observations and exact envelopes while retaining conflicts and gaps", () => {
    const envelope = { name: "wire", digest: { sha256: "c".repeat(64) } };
    const first = buildObservationArchive({ submission: submissionFor(1).reference.record, capturedThrough: { at: "2026-08-13T00:00:00Z" }, snapshots: [
      { observation: observation("duplicate"), exactEnvelope: envelope }, { observation: observation("duplicate"), exactEnvelope: envelope },
      { observation: observation("conflict", "one") }, { observation: observation("conflict", "two") },
    ] });
    expect(first.archive.streams[0]!.observations).toHaveLength(1);
    expect(first.archive.streams[0]!.conflicts).toHaveLength(1);
    expect(first.archive.streams[0]!.exactEnvelopes).toEqual([envelope]);
  });

  test("rehashes exact Submission bytes and binds canonical cell, arm, replicate, and dispatch index", () => {
    expect(accounting().record.cells[0]!.dispatches[0]!.submission).toEqual(submissionFor(1).reference);
    const first = submissionFor(1); const second = submissionFor(2);
    expect(() => accounting([{ cellKey: cell, index: 1, submission: { ...first.reference, record: { ...first.reference.record, digest: { sha256: hex } } }, submissionBytes: first.bytes }])).toThrow("descriptor");
    expect(() => accounting([{ cellKey: cell, index: 1, submission: second.reference, submissionBytes: second.bytes }, { cellKey: cell, index: 2, submission: first.reference, submissionBytes: first.bytes }])).toThrow("dispatch index");
  });

  test("verifier fails wrong digest, dispatch-index substitution, and omitted scope; unavailable scope is indeterminate", async () => {
    const value = accounting().record; const first = submissionFor(1); const second = submissionFor(2);
    const firstDigest = `sha256:${first.reference.record.digest.sha256}` as const;
    const wrongDigest = await verifyBenchmarkAccounting({ runOwner: "did:example:publisher", expectedCellKeys: [cell], accounting: value, submissions: new Map([[firstDigest, { bytes: second.bytes }]]) });
    expect(wrongDigest.checks).toContainEqual(expect.objectContaining({ name: "submission-reference-digest", status: "fail" }));
    const swapped = { ...value, cells: [{ ...value.cells[0]!, dispatches: [{ ...value.cells[0]!.dispatches[0]!, index: 2 }] }] };
    const wrongIndex = await verifyBenchmarkAccounting({ runOwner: "did:example:publisher", expectedCellKeys: [cell], accounting: swapped, submissions: new Map([[firstDigest, { bytes: first.bytes }]]) });
    expect(wrongIndex.status).toBe("fail");
    const omitted = await verifyBenchmarkAccounting({ runOwner: "did:example:publisher", expectedCellKeys: [cell], accounting: value, scope: { async enumerate() { return { status: "complete", dispatches: [{ cellKey: `${hex}/arm/2`, submissionDigest: `sha256:${hex}` }] }; } } });
    expect(omitted.status).toBe("fail");
    const unavailable = await verifyBenchmarkAccounting({ runOwner: "did:example:publisher", expectedCellKeys: [cell], accounting: value, scope: { async enumerate() { return { status: "unavailable", detail: "offline" }; } } });
    expect(unavailable.status).toBe("indeterminate");
  });

  test("validates semantic Run → registration artifacts → Accounting → Matrix v2 closure and third-party authority", () => {
    const { input } = publicationFixture(); const plan = buildBenchmarkPublicationPlan(input);
    expect(plan.stages).toHaveLength(2);
    expect(plan.stages[1]!.members.find((member) => member.id === "delivery")!.actions).toEqual(["verify-origin", "mirror"]);
    expect(plan.stages[1]!.members.find((member) => member.id === "matrix")!.dependsOn).toContain("accounting");
    expect(() => buildBenchmarkPublicationPlan(publicationFixture({ includeArtifact: false }).input)).toThrow("registration artifact");
    expect(() => buildBenchmarkPublicationPlan(publicationFixture({ matrixVersion: "1.0" }).input)).toThrow("assembly v2");
    expect(() => buildBenchmarkPublicationPlan(publicationFixture({ matrixRunDigest: "e".repeat(64) }).input)).toThrow("selected exact Run");
    expect(() => buildBenchmarkPublicationPlan(publicationFixture({ matrixCloseAt: "2026-08-13T00:00:01Z" }).input)).toThrow("closeBoundary");
    const valid = publicationFixture().input; const arbitrary = sealRecord({ arbitrary: true });
    const invalid = { ...valid, registration: valid.registration.map((member) => member.id === "run" ? { ...member, bytes: arbitrary.bytes, digest: arbitrary.digest } : member) };
    expect(() => buildBenchmarkPublicationPlan(invalid)).toThrow("exact Run bytes");
  });

  test("rejects valid semantic record bytes carrying a non-canonical media type", () => {
    const runFixture = publicationFixture().input;
    expect(() => buildBenchmarkPublicationPlan({
      ...runFixture,
      registration: runFixture.registration.map((candidate) => candidate.id === "run" ? { ...candidate, mediaType: "application/json" } : candidate),
    })).toThrow("Run publication member mediaType");

    const accountingFixture = publicationFixture().input;
    expect(() => buildBenchmarkPublicationPlan({
      ...accountingFixture,
      accounting: { ...accountingFixture.accounting, accounting: { ...accountingFixture.accounting.accounting, mediaType: "text/plain" } },
    })).toThrow("BenchmarkAccounting publication member mediaType");

    const matrixFixture = publicationFixture().input;
    expect(() => buildBenchmarkPublicationPlan({
      ...matrixFixture,
      accounting: { ...matrixFixture.accounting, matrix: { ...matrixFixture.accounting.matrix, mediaType: "application/json" } },
    })).toThrow("Matrix publication member mediaType");

    const reportFixture = publicationFixture({ report: true }).input;
    expect(() => buildBenchmarkPublicationPlan({
      ...reportFixture,
      report: { ...reportFixture.report!, record: { ...reportFixture.report!.record, mediaType: "text/plain" } },
    })).toThrow("signed Report v2 publication member mediaType");
  });

  test("exact-parses signed Report v2 and binds its subject and publication disclosure", () => {
    expect(buildBenchmarkPublicationPlan(publicationFixture({ report: true }).input).stages).toHaveLength(3);
    expect(buildBenchmarkPublicationPlan(publicationFixture({ report: true, publicRegistration: "pre-dispatch-fail" }).input).stages).toHaveLength(3);
    expect(() => buildBenchmarkPublicationPlan(publicationFixture({ report: true, reportMatrixDigest: "d".repeat(64) }).input)).toThrow("subject");
    expect(() => buildBenchmarkPublicationPlan(publicationFixture({ report: true, publicRegistration: "pre-dispatch-fail", reportCheck: { status: "pass" } }).input)).toThrow("canonical derivation");
    expect(() => buildBenchmarkPublicationPlan(publicationFixture({ report: true, publicRegistration: "pre-dispatch-fail", reportCheck: { status: "fail", detail: "forged ordering detail" } }).input)).toThrow("canonical derivation");
  });
});
