import { describe, expect, it } from "vitest";
import { projectPolicyOutcomes } from "./projection.js";
import type { PolicyOutcomeObservation } from "./observation.js";

/**
 * Substrate §6.2/§6.3, the re-announcement boundary: "the same underlying verdict record
 * announced through a second discovery source must not inflate a row -- the adapter contract
 * dedupes on the underlying verdict record digest, not only on the announcement dedupe tuple".
 *
 * This package's own fold ONLY dedupes on the announcement tuple (source, entry,
 * announcementId), identical to `@jinn-network/task-curation`'s precedent (§6.2 says the fold
 * discipline is "inherited verbatim from curation"). It has no way to know two different
 * announcements describe the same underlying fact -- that join belongs to the tier-4 adapter
 * (§6.3), which this package does not implement.
 *
 * What THIS package can honestly assert, and does here:
 *  1. Without adapter-side dedupe, a re-announcement through a second source DOES inflate the
 *     row (dishonest to hide this -- so it is demonstrated, not silently prevented).
 *  2. `PolicyOutcomeInputRef.record` (mirroring `CurationInputRef.record`, i.e.
 *     `AnnouncedItem.record.digest` -- a content digest, not an announcement-event digest) is
 *     carried on every ref and is IDENTICAL across the two re-announcements of the same
 *     underlying record. This is the field the design says C2 must supply so the adapter CAN
 *     dedupe (`ref` "carries the verdict record digest" per the task charter). A consumer
 *     grouping `inputRefs` by `ref.record` can detect and collapse the duplicate post-hoc,
 *     exactly as curation's cohort filter collapses sybil inflation.
 *
 * See README "Findings" F-C2-2 for the residual scope question this test does NOT resolve: this
 * package only mirrors `AnnouncedItem.record.digest` onto `ref.record` -- whether that field is
 * guaranteed source-invariant for the SAME underlying fact is a property of the upstream
 * marketplace projector (`packages/marketplace/projector/src/announce.ts`), outside this
 * package's boundary and outside C2's remit to verify.
 */

const TUPLE = {
  formatToken: "network.jinn.policy.execution-tuple/1.0",
  harness: { id: "claude-code", version: "2.1.34" },
  model: { id: "anthropic/claude-haiku-4-5" },
  loadout: null,
  isolationPolicy: "unrestricted",
} as const;

const SHARED_RECORD_DIGEST = `sha256:${"9".repeat(64)}` as const;

function baseObservation(): PolicyOutcomeObservation {
  return {
    tuple: TUPLE,
    perAxisStatus: { harness: "match", model: "match", loadout: "match", isolationPolicy: "match" },
    taskDigest: `sha256:${"c".repeat(64)}`,
    verdict: "pass",
    observedAt: "2026-08-05T00:00:00Z",
    attribution: "urn:jinn:agent:solver-a",
    ref: {
      source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
      entry: `sha256:${"a".repeat(64)}`,
      announcementId: "ann-primary-001",
      record: SHARED_RECORD_DIGEST,
      attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-000000000001",
    },
  };
}

/** The SAME underlying verdict, re-announced through a distinct second discovery source. */
function reannounced(primary: PolicyOutcomeObservation): PolicyOutcomeObservation {
  return {
    ...primary,
    ref: {
      source: { agent: "https://jinn.network/agents/mirror-projector", name: "secondary-mirror" },
      entry: `sha256:${"d".repeat(64)}`,
      announcementId: "ann-secondary-001",
      record: SHARED_RECORD_DIGEST, // same underlying record content -- the SAME verdict
      attemptUri: primary.ref.attemptUri,
    },
  };
}

describe("re-announcement: the announcement dedupe tuple alone does not catch it", () => {
  it("counts the re-announcement as a SECOND verdict -- honestly disclosed, not silently prevented", () => {
    const primary = baseObservation();
    const [row] = projectPolicyOutcomes([primary, reannounced(primary)]).rows;
    expect(row.verdicts).toBe(2);
    expect(row.inputRefs).toHaveLength(2);
  });

  it("both refs carry the SAME ref.record -- the field an adapter/consumer needs to dedupe", () => {
    const primary = baseObservation();
    const [row] = projectPolicyOutcomes([primary, reannounced(primary)]).rows;
    const records = new Set(row.inputRefs.map((r) => r.record));
    expect(records.size).toBe(1);
    expect([...records][0]).toBe(SHARED_RECORD_DIGEST);
  });

  it("a consumer grouping inputRefs by ref.record can re-derive the de-duplicated rate", () => {
    const primary = baseObservation();
    const inflated = projectPolicyOutcomes([primary, reannounced(primary)]).rows[0];
    const byRecord = new Map(inflated.inputRefs.map((ref) => [ref.record, ref]));
    expect(byRecord.size).toBe(1); // exactly one DISTINCT underlying verdict record
    // A single-source projection of the same fact is the de-duplicated baseline.
    const dedupedRow = projectPolicyOutcomes([primary]).rows[0];
    expect(dedupedRow.verdicts).toBe(1);
    expect(dedupedRow.passRate).toEqual({ num: 1, den: 1 });
  });

  it("a true redelivery of the SAME announcement (identical ref) is still a no-op, unaffected by this", () => {
    const primary = baseObservation();
    const projected = projectPolicyOutcomes([primary, primary]).rows[0];
    expect(projected.verdicts).toBe(1);
  });
});
