// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { validateCandidateManifest } from "@jinn-network/policy-identity";
import {
  assembleEvidenceBundle,
  provenanceMatchesBundle,
  recordListDigest,
} from "./bundle.js";
import { EVIDENCE_BUNDLE_FORMAT_TOKEN } from "../tokens.js";
import {
  BOUNDARY,
  CLEAN_RECORDS,
  SAVED_QUERY_DIGEST,
  SNAPSHOT_RECEIPT,
  cleanBundle,
  digestOf,
  manifestFor,
  PARENT_TUPLE,
  recordRef,
} from "../testing/admission-fixtures.js";

const base = {
  savedQueryDigest: SAVED_QUERY_DIGEST,
  snapshotReceipt: SNAPSHOT_RECEIPT,
  records: CLEAN_RECORDS,
  boundary: BOUNDARY,
};

describe("assembleEvidenceBundle", () => {
  it("seals a content-addressed manifest of digests only", () => {
    const { bundle, digest, provenance } = cleanBundle();
    expect(bundle.formatToken).toBe(EVIDENCE_BUNDLE_FORMAT_TOKEN);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundle.heldOutBoundary).toEqual({
      kind: "benchmark",
      ref: BOUNDARY.source.ref,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(provenance).toEqual({
      savedQueryDigest: SAVED_QUERY_DIGEST,
      snapshotReceipt: SNAPSHOT_RECEIPT,
      recordListDigest: bundle.recordListDigest,
    });
  });

  it("never carries the boundary's items — only its digest and source reference", () => {
    const text = JSON.stringify(cleanBundle().bundle);
    for (const secret of [...BOUNDARY.instanceIds, ...BOUNDARY.repos]) {
      expect(text).not.toContain(secret);
    }
  });

  it("is byte-stable across two assemblies of the same inputs", () => {
    expect(cleanBundle().digest).toBe(cleanBundle().digest);
  });

  it("produces provenance a candidate manifest validates with (this is what unblocks F-C6-1)", () => {
    const result = validateCandidateManifest(manifestFor(PARENT_TUPLE));
    expect(result.ok).toBe(true);
  });

  // --- ruling R5: the refusal, not the helper, is the control ---

  it("REFUSES a bundle containing a record excluded on instance id", () => {
    expect(() => assembleEvidenceBundle({
      ...base,
      records: [...CLEAN_RECORDS, recordRef("e", {
        instanceId: "astropy__astropy-12907",
        repo: "astropy/astropy",
      })],
    })).toThrow(expect.objectContaining({ category: "held-out-contamination" }));
  });

  it("REFUSES a bundle containing a record excluded on repo alone", () => {
    expect(() => assembleEvidenceBundle({
      ...base,
      records: [recordRef("e", { instanceId: "django__django-99999", repo: "django/django" })],
    })).toThrow(/inside the held-out boundary on repo django\/django/);
  });

  it("REFUSES an unattributable record: 'could not check' is not 'checked and clean'", () => {
    expect(() => assembleEvidenceBundle({ ...base, records: [recordRef("e")] }))
      .toThrow(/nothing establishes it is outside the held-out boundary/);
  });

  it("reports every excluded record, not only the first", () => {
    try {
      assembleEvidenceBundle({
        ...base,
        records: [
          recordRef("d", { instanceId: "astropy__astropy-12907" }),
          recordRef("e", { repo: "django/django" }),
        ],
      });
      expect.unreachable("assembly must refuse");
    } catch (error) {
      expect((error as { errors: unknown[] }).errors).toHaveLength(2);
    }
  });

  it("cannot be reached without a boundary", () => {
    expect(() => assembleEvidenceBundle({ ...base, boundary: undefined as never }))
      .toThrow(expect.objectContaining({ category: "held-out-boundary" }));
  });

  // --- shape refusals ---

  it("refuses a receipt naming a different saved query", () => {
    expect(() => assembleEvidenceBundle({
      ...base,
      snapshotReceipt: { ...SNAPSHOT_RECEIPT, savedQueryDigest: digestOf("9") },
    })).toThrow(/names a different saved query/);
  });

  it("refuses a malformed saved-query digest", () => {
    expect(() => assembleEvidenceBundle({ ...base, savedQueryDigest: "nope" }))
      .toThrow(/savedQueryDigest must be sha256/);
  });

  it("refuses a receipt missing its reproducibility flag", () => {
    const { reproducibility: _dropped, ...rest } = SNAPSHOT_RECEIPT;
    expect(() => assembleEvidenceBundle({ ...base, snapshotReceipt: rest as never }))
      .toThrow(/reproducibility must be/);
  });

  it("seals an empty record list rather than treating 'nothing matched' as an absence", () => {
    const { bundle } = assembleEvidenceBundle({ ...base, records: [] });
    expect(bundle.records).toEqual([]);
    expect(bundle.recordListDigest).toMatch(/^sha256:/);
  });
});

describe("recordListDigest", () => {
  it("is order-sensitive: a ranking is part of what the proposer consumed", () => {
    const reversed = [...CLEAN_RECORDS].reverse();
    expect(recordListDigest(reversed)).not.toBe(recordListDigest(CLEAN_RECORDS));
  });

  it("treats an omitted member and an explicitly-undefined one as the same list", () => {
    const explicit = CLEAN_RECORDS.map((record) => ({ ...record, extraneous: undefined } as never));
    expect(recordListDigest(explicit)).toBe(recordListDigest(CLEAN_RECORDS));
  });
});

describe("provenanceMatchesBundle", () => {
  const { bundle, provenance } = cleanBundle();

  it("accepts the provenance the bundle issued", () => {
    expect(provenanceMatchesBundle(provenance, bundle)).toBe(true);
  });

  it("refuses a record-list digest copied onto a different receipt", () => {
    const forged = {
      ...provenance,
      snapshotReceipt: { ...bundle.snapshotReceipt, evaluatedAt: "2026-08-03T10:00:00Z" },
    };
    expect(provenanceMatchesBundle(forged, bundle)).toBe(false);
  });

  it("refuses a swapped record-list digest", () => {
    expect(provenanceMatchesBundle({ ...provenance, recordListDigest: digestOf("0") }, bundle))
      .toBe(false);
  });

  it("refuses a swapped saved-query digest", () => {
    expect(provenanceMatchesBundle({ ...provenance, savedQueryDigest: digestOf("0") }, bundle))
      .toBe(false);
  });
});
