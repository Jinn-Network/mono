// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { compareCalendarStrictRfc3339Instants, OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE } from "@jinn-network/trust-core";
import {
  KIT_BITCOIN_BLOCK_TIME,
  buildAnchorEvidenceRecord,
  buildOpenTimestampsAnchorEvidenceRecord,
  buildRfc3161AnchorEvidenceRecord,
  createFixtureAuthority,
  createOpenTimestampsKitFixtures,
} from "@jinn-network/trust-testing";

import { evaluateAnchors } from "../index.js";
import type { AnchorRefusal, AnchorTrustMaterial, CarriedAnchorRecord } from "../index.js";

const TASK_KIND = "https://spec.jinn.network/records/task/v1";
const DELIVERY_KIND = "https://spec.jinn.network/records/delivery/v1";
const TASK_SHA256 = "1".repeat(64);
const DELIVERY_SHA256 = "2".repeat(64);
const UNRELATED_SHA256 = "3".repeat(64);
const GEN_TIME_DER = "20260501120000Z";
const GEN_TIME = "2026-05-01T12:00:00Z";

const SUBJECTS = [
  { id: "task", sha256: TASK_SHA256, kind: TASK_KIND },
  { id: "delivery", sha256: DELIVERY_SHA256, kind: DELIVERY_KIND },
];

const authority = createFixtureAuthority("evaluate-anchors");
const ots = createOpenTimestampsKitFixtures(hexToBytes(TASK_SHA256));

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function carried(built: { readonly bytes: Uint8Array; readonly recordDigest: string }): CarriedAnchorRecord {
  return { recordSha256: built.recordDigest.slice("sha256:".length), bytes: built.bytes };
}

function rfc3161(options: { readonly subjectSha256?: string; readonly subjectKind?: string; readonly genTimeDer?: string } = {}) {
  const subjectSha256 = options.subjectSha256 ?? TASK_SHA256;
  return carried(buildRfc3161AnchorEvidenceRecord({
    subjectKind: options.subjectKind ?? TASK_KIND,
    subjectSha256,
    proofBytes: authority.mintTimeStampToken({ subjectSha256, genTime: options.genTimeDer ?? GEN_TIME_DER }).tokenDer,
  }));
}

function evaluate(records: readonly CarriedAnchorRecord[], trust?: AnchorTrustMaterial) {
  return evaluateAnchors({ records, subjects: SUBJECTS, ...(trust === undefined ? {} : { trust }) });
}

describe("evaluateAnchors", () => {
  test("a complete anchor is present without trust material and verified with it", () => {
    const record = rfc3161();
    expect(evaluate([record]).anchors).toEqual([expect.objectContaining({
      recordSha256: record.recordSha256,
      status: "present",
      provider: RFC3161_TSA_ANCHOR_PROFILE,
      subject: "task",
      timeBasis: "authority-time",
      trustMaterial: "none",
      facts: expect.objectContaining({ genTime: GEN_TIME }),
    })]);
    expect(evaluate([record]).anchors[0]!.time).toBeUndefined();

    const verified = evaluate([record], { rfc3161: { trustAnchorsDer: [authority.certificateDer] } }).anchors[0]!;
    expect(verified).toMatchObject({ status: "verified", trustMaterial: "supplied", time: GEN_TIME });
  });

  test("a digest no subject carries is invalid and claims no subject", () => {
    const report = evaluate([rfc3161({ subjectSha256: UNRELATED_SHA256 })]);
    expect(report.anchors[0]).toMatchObject({ status: "invalid", provider: RFC3161_TSA_ANCHOR_PROFILE, trustMaterial: "none" });
    expect(report.anchors[0]!.reason).toContain(UNRELATED_SHA256);
    expect(report.anchors[0]!.subject).toBeUndefined();
    expect(report.invalid).toHaveLength(1);
    expect(report.subjects.map(({ outcome }) => outcome)).toEqual(["absent", "absent"]);
  });

  test("a kind label that misdescribes the record its digest resolves to is invalid", () => {
    const report = evaluate([rfc3161({ subjectKind: DELIVERY_KIND })]);
    expect(report.anchors[0]).toMatchObject({ status: "invalid", subject: "task" });
    expect(report.anchors[0]!.reason).toContain(DELIVERY_KIND);
  });

  test("a subject the caller cannot name a kind for skips only that comparison", () => {
    const report = evaluateAnchors({
      records: [rfc3161({ subjectKind: "https://example.test/records/whatever/v1" })],
      subjects: [{ id: "held", sha256: TASK_SHA256 }],
    });
    expect(report.anchors[0]).toMatchObject({ status: "present", subject: "held" });
  });

  test("a provider no verifier implements is invalid, by name", () => {
    const report = evaluate([carried(buildAnchorEvidenceRecord({
      subjectKind: TASK_KIND,
      subjectSha256: TASK_SHA256,
      provider: "https://spec.jinn.network/trust/anchor-profiles/not-implemented/v1",
      proofMediaType: "application/octet-stream",
      proofBytes: Uint8Array.of(1, 2, 3, 4),
    }))]);
    expect(report.anchors[0]).toMatchObject({ status: "invalid", subject: "task" });
    expect(report.anchors[0]!.reason).toContain("not-implemented/v1");
  });

  test("bytes that are not an anchor are invalid and report no provider", () => {
    const report = evaluate([{ recordSha256: "a".repeat(64), bytes: new TextEncoder().encode("{}") }]);
    expect(report.anchors[0]).toMatchObject({ status: "invalid", trustMaterial: "none" });
    expect(report.anchors[0]!.provider).toBeUndefined();
    expect(report.anchors[0]!.reason).toMatch(/^not the exact sealed encoding of a conforming AnchorEvidence record: /u);
  });

  test("one unreadable proof does not take the report down, and entries sort by record digest", () => {
    const good = rfc3161();
    const bad = { recordSha256: "0".repeat(64), bytes: Uint8Array.of(0xff) };
    const report = evaluate([good, bad]);
    expect(report.anchors.map(({ recordSha256 }) => recordSha256)).toEqual(
      [good.recordSha256, bad.recordSha256].sort(),
    );
    expect(report.anchors.map(({ status }) => status).sort()).toEqual(["invalid", "present"]);
  });

  test("a pending proof and a complete one are each reported on their own bytes", () => {
    const pending = carried(buildOpenTimestampsAnchorEvidenceRecord({ subjectKind: TASK_KIND, subjectSha256: TASK_SHA256, proofBytes: ots.pendingProof }));
    const complete = carried(buildOpenTimestampsAnchorEvidenceRecord({ subjectKind: TASK_KIND, subjectSha256: TASK_SHA256, proofBytes: ots.completeProof }));
    const report = evaluate([pending, complete]);
    const byDigest = new Map(report.anchors.map((entry) => [entry.recordSha256, entry]));
    expect(byDigest.get(pending.recordSha256)).toMatchObject({ status: "pending", timeBasis: "authority-time" });
    expect(byDigest.get(pending.recordSha256)!.reason).toEqual(expect.any(String));
    expect(byDigest.get(complete.recordSha256)).toMatchObject({ status: "present", timeBasis: "chain-time" });

    const headers = { blockHeaders: ots.blockHeaders.map(({ height, header }) => ({ height, header })) };
    const verified = evaluate([complete], { opentimestamps: headers }).anchors[0]!;
    expect(verified).toMatchObject({ status: "verified", time: KIT_BITCOIN_BLOCK_TIME });
  });

  test("absence is an outcome: anchored, absent, and declared-but-absent", () => {
    expect(evaluate([]).subjects).toEqual([
      { subject: "task", outcome: "absent" },
      { subject: "delivery", outcome: "absent" },
    ]);
    expect(evaluate([rfc3161()]).subjects[0]).toEqual({ subject: "task", outcome: "anchored" });

    const declared = evaluateAnchors({
      records: [rfc3161()],
      subjects: [{ ...SUBJECTS[0]!, declaredProfiles: [OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE] }],
    });
    expect(declared.subjects).toEqual([
      { subject: "task", outcome: "declared-but-absent", declaredProfiles: [OPENTIMESTAMPS_ANCHOR_PROFILE] },
    ]);
  });

  test("a caller's rule can refuse a proof that verified, and the subject reads as unanchored", () => {
    const seen: unknown[] = [];
    const report = evaluateAnchors({
      records: [rfc3161()],
      subjects: SUBJECTS,
      rejectProof: (proof) => {
        seen.push(proof.subject, proof.timeBasis);
        return "after this subject's own deadline";
      },
    });
    expect(seen).toEqual(["task", "authority-time"]);
    expect(report.anchors[0]).toMatchObject({
      status: "invalid",
      reason: "after this subject's own deadline",
      provider: RFC3161_TSA_ANCHOR_PROFILE,
      subject: "task",
      trustMaterial: "none",
    });
    expect(report.invalid).toHaveLength(1);
    expect(report.subjects[0]).toEqual({ subject: "task", outcome: "absent" });
  });
});

/**
 * What a later step of the Colophon checker must reproduce, spelled out here rather than imported:
 * this package may not depend on it. The strings are those of `evaluateIntegrityAnchors`.
 */
describe("a caller can render the reasons it has always printed", () => {
  const RUN_KIND = "https://spec.jinn.network/records/benchmark-run/v1";
  const MATRIX_KIND = "https://spec.jinn.network/records/benchmark-matrix/v1";
  const NAMES: Readonly<Record<string, string>> = { lock: "Run", matrix: "Matrix" };
  const CLOSE_AT = "2026-06-01T00:00:00Z";

  function renderReason(refusal: AnchorRefusal): string | undefined {
    if (refusal.code === "unknown-subject") {
      return `the anchored digest ${refusal.digest} is neither this bundle's sealed Run nor its sealed Matrix`;
    }
    if (refusal.code === "subject-kind-mismatch") {
      return `subject.kind is ${refusal.kind}, but its digest resolves to this bundle's sealed ${NAMES[refusal.subject]!}`;
    }
    return undefined;
  }

  const subjects = [
    { id: "lock", sha256: TASK_SHA256, kind: RUN_KIND },
    { id: "matrix", sha256: DELIVERY_SHA256, kind: MATRIX_KIND },
  ];

  function reason(record: CarriedAnchorRecord): string {
    return evaluateAnchors({
      records: [record],
      subjects,
      renderReason,
      rejectProof: ({ subject, timeBasis, facts }) => {
        if (subject !== "lock" || timeBasis !== "authority-time") return undefined;
        const { genTime } = facts as { readonly genTime?: unknown };
        const compared = typeof genTime === "string" ? compareCalendarStrictRfc3339Instants(genTime, CLOSE_AT) : undefined;
        if (compared !== undefined && compared <= 0) return undefined;
        return typeof genTime === "string"
          ? `the token's genTime ${genTime} is after this run's own pre-registered close instant ${CLOSE_AT}`
          : "an authority-time lock anchor carries no comparable genTime";
      },
    }).anchors[0]!.reason!;
  }

  test("the dangling anchor", () => {
    expect(reason(rfc3161({ subjectKind: RUN_KIND, subjectSha256: UNRELATED_SHA256 })))
      .toBe(`the anchored digest ${UNRELATED_SHA256} is neither this bundle's sealed Run nor its sealed Matrix`);
  });

  test("the misdescribed kind", () => {
    expect(reason(rfc3161({ subjectKind: MATRIX_KIND })))
      .toBe(`subject.kind is ${MATRIX_KIND}, but its digest resolves to this bundle's sealed Run`);
  });

  test("the splice-catch", () => {
    expect(reason(rfc3161({ subjectKind: RUN_KIND, genTimeDer: "20260601120000Z" })))
      .toBe(`the token's genTime 2026-06-01T12:00:00Z is after this run's own pre-registered close instant ${CLOSE_AT}`);
  });

  test("the unimplemented provider keeps the default wording", () => {
    const record = carried(buildAnchorEvidenceRecord({
      subjectKind: RUN_KIND,
      subjectSha256: TASK_SHA256,
      provider: "https://spec.jinn.network/trust/anchor-profiles/not-implemented/v1",
      proofMediaType: "application/octet-stream",
      proofBytes: Uint8Array.of(1),
    }));
    expect(reason(record)).toBe(
      "no proof verifier implements the anchor profile https://spec.jinn.network/trust/anchor-profiles/not-implemented/v1",
    );
  });
});
