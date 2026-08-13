import { describe, expect, test } from "vitest";
import {
  BENCHMARK_ACCOUNTING_MEDIA_TYPE, BENCHMARK_ACCOUNTING_RECORD_KIND, BENCHMARKING_PROTOCOL,
  MATRIX_MEDIA_TYPE, MATRIX_RECORD_KIND, REPORT_V2_RECORD_KIND, RUN_MEDIA_TYPE, RUN_RECORD_KIND,
  sealRecord,
} from "@jinn-network/benchmarking-records";
import { sealSubmission } from "@jinn-network/task-execution-protocol";
import { sha256 } from "@jinn-network/record-publication";
import { buildBenchmarkAccounting, buildBenchmarkPublicationPlan, buildObservationArchive, verifyBenchmarkAccounting } from "./index.js";

const encoder = new TextEncoder();
const hex = "a".repeat(64);
const run = { name: "run", digest: { sha256: hex } };
const submissionBytes = sealSubmission({
  protocol: "https://spec.jinn.network/profiles/task-execution/v1", submission: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
  task: { digest: { sha256: hex } }, requester: "did:example:publisher", idempotencyKey: "dispatch-1", nonce: "nonce",
  deadline: "2026-08-14T00:00:00Z", attempts: { maxTotal: 1, maxConcurrent: 1 },
  annotations: { run: `sha256:${hex}`, cellKey: `${hex}/arm/1`, armId: "arm" },
});
const submission = { kind: "https://spec.jinn.network/records/submission/v1", record: { name: "submission", digest: { sha256: sha256(submissionBytes).slice(7) } } };
const scope = [{ role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1", kind: "record-discovery" as const, source: { agent: "did:example:publisher", name: "benchmarks" }, through: { sequence: "0000000000000042", entry: `sha256:${hex}` } }];

function accounting() {
  return buildBenchmarkAccounting({ run, runOwner: "did:example:publisher", publisher: "did:example:publisher", publisherAuthority: { kind: "run-owner" }, scope,
    publicRegistration: { status: "post-hoc" }, closeBoundary: { at: "2026-08-13T00:00:00Z" }, expectedCellKeys: [`${hex}/arm/1`],
    dispatches: [{ cellKey: `${hex}/arm/1`, index: 1, submission, submissionBytes }],
  });
}
const observation = (id: string, detail = "same") => ({ specversion: "1.0" as const, id, source: "https://runtime.example/stream", subject: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa", time: "2026-08-13T00:00:00Z", datacontenttype: "application/json" as const, sequence: "0000000000000002", type: "network.jinn.task-execution.attempt-terminal.v1" as const, data: { state: "failed" as const, detail } });

describe("benchmark publication", () => {
  test("archives duplicates, conflicts, and sequence gaps deterministically without rewriting transport envelopes", () => {
    const first = buildObservationArchive({ submission: submission.record, capturedThrough: { at: "2026-08-13T00:00:00Z" }, snapshots: [
      { observation: observation("duplicate") }, { observation: observation("duplicate") }, { observation: observation("conflict", "one") }, { observation: observation("conflict", "two") },
    ] });
    expect(first.archive.streams[0]!.observations).toHaveLength(1);
    expect(first.archive.streams[0]!.conflicts).toHaveLength(1);
    expect(first.sealed.digest).toMatch(/^sha256:/);
  });

  test("builds complete accounting only for expected cells and explicit one-attempt dispatches", () => {
    const result = accounting();
    expect(result.record.cells[0]!.dispatches[0]!.submission).toEqual(submission);
    expect(() => buildBenchmarkAccounting({ run, runOwner: "did:example:publisher", publisher: "did:example:publisher", publisherAuthority: { kind: "run-owner" }, scope, publicRegistration: { status: "post-hoc" }, closeBoundary: { at: "2026-08-13T00:00:00Z" }, expectedCellKeys: [`${hex}/arm/1`], dispatches: [{ cellKey: `${hex}/arm/1`, index: 2, submission, submissionBytes }] })).toThrow("no gaps");
  });

  test("fails an omitted in-scope dispatch and marks unavailable authoritative streams indeterminate", async () => {
    const value = accounting().record;
    const omitted = await verifyBenchmarkAccounting({ runOwner: "did:example:publisher", expectedCellKeys: [`${hex}/arm/1`], accounting: value, scope: { async enumerate() { return { status: "complete", dispatches: [{ cellKey: `${hex}/arm/2`, submissionDigest: `sha256:${hex}` }] }; } } });
    expect(omitted.status).toBe("fail");
    const unavailable = await verifyBenchmarkAccounting({ runOwner: "did:example:publisher", expectedCellKeys: [`${hex}/arm/1`], accounting: value, scope: { async enumerate() { return { status: "unavailable", detail: "offline" }; } } });
    expect(unavailable.status).toBe("indeterminate");
  });

  test("creates owner/delegate announcements but preserves third-party origin authority and supports accounting-only closure", () => {
    const bytes = (value: unknown) => sealRecord(value as never);
    const runBytes = bytes({ run: true }); const accountingBytes = bytes({ accounting: true }); const matrixBytes = bytes({ matrix: true }); const deliveryBytes = bytes({ delivery: true });
    const plan = buildBenchmarkPublicationPlan({ id: "publication-1", runId: "run", registration: [{ id: "run", kind: RUN_RECORD_KIND, digest: runBytes.digest, bytes: runBytes.bytes, mediaType: RUN_MEDIA_TYPE, authority: { mode: "owner" }, announcementTimestamp: "2026-08-13T00:00:00Z" }], accounting: {
      members: [{ id: "delivery", kind: "https://spec.jinn.network/records/delivery/v1", digest: deliveryBytes.digest, bytes: deliveryBytes.bytes, mediaType: "application/json", authority: { mode: "origin-reference", origin: { source: { agent: "did:operator", name: "deliveries" }, sequence: "0000000000000001", entryDigest: deliveryBytes.digest }, mirror: true } }],
      accounting: { id: "accounting", kind: BENCHMARK_ACCOUNTING_RECORD_KIND, digest: accountingBytes.digest, bytes: accountingBytes.bytes, mediaType: BENCHMARK_ACCOUNTING_MEDIA_TYPE, authority: { mode: "delegate" }, announcementTimestamp: "2026-08-13T00:01:00Z" },
      matrix: { id: "matrix", kind: MATRIX_RECORD_KIND, digest: matrixBytes.digest, bytes: matrixBytes.bytes, mediaType: MATRIX_MEDIA_TYPE, authority: { mode: "owner" }, announcementTimestamp: "2026-08-13T00:02:00Z" },
    } });
    expect(plan.stages).toHaveLength(2);
    const delivery = plan.stages[1]!.members.find((member) => member.id === "delivery")!;
    expect(delivery.actions).toEqual(["verify-origin", "mirror"]);
    expect(plan.stages[1]!.members.find((member) => member.id === "matrix")!.dependsOn).toContain("accounting");
    expect(REPORT_V2_RECORD_KIND).toContain("/v2");
  });
});
