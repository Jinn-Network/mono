// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PolicyOptimizationError } from "../errors.js";
import {
  assertValidBoundary,
  assertValidRecordRefs,
  boundaryIsEmpty,
  heldOutBoundaryDigest,
  partitionHeldOut,
  scanLexical,
  type HeldOutBoundary,
} from "./held-out.js";
import { BOUNDARY, recordRef } from "../testing/admission-fixtures.js";

describe("the held-out boundary", () => {
  it("digests as a set: order and duplicates do not change it", () => {
    const shuffled: HeldOutBoundary = {
      ...BOUNDARY,
      instanceIds: [...BOUNDARY.instanceIds].reverse().concat(BOUNDARY.instanceIds[0]!),
      repos: [...BOUNDARY.repos].reverse(),
    };
    expect(heldOutBoundaryDigest(shuffled)).toBe(heldOutBoundaryDigest(BOUNDARY));
  });

  it("digests differently when the boundary actually widens", () => {
    const wider = { ...BOUNDARY, instanceIds: [...BOUNDARY.instanceIds, "extra__extra-1"] };
    expect(heldOutBoundaryDigest(wider)).not.toBe(heldOutBoundaryDigest(BOUNDARY));
  });

  it("refuses a malformed boundary rather than narrowing it", () => {
    for (const bad of [
      null,
      { ...BOUNDARY, source: { kind: "guess", ref: "x" } },
      { ...BOUNDARY, source: { kind: "slate", ref: "" } },
      { ...BOUNDARY, instanceIds: ["", "a"] },
      { ...BOUNDARY, repos: "astropy/astropy" },
      { ...BOUNDARY, lexicalIdentifiers: [1] },
    ]) {
      expect(() => assertValidBoundary(bad, "boundary"))
        .toThrow(expect.objectContaining({ category: "held-out-boundary" }));
    }
  });

  it("knows when it excludes nothing", () => {
    expect(boundaryIsEmpty(BOUNDARY)).toBe(false);
    expect(boundaryIsEmpty({ ...BOUNDARY, instanceIds: [], repos: [] })).toBe(true);
  });
});

describe("partitionHeldOut — the R5 query-layer filter", () => {
  it("excludes on instance id, exactly (the mirrored excludeHeldOutSlate semantics)", () => {
    const { kept, excluded } = partitionHeldOut([
      recordRef("1", { instanceId: "astropy__astropy-12907", repo: "astropy/astropy" }),
      recordRef("2", { instanceId: "sympy__sympy-20154", repo: "sympy/sympy" }),
    ], BOUNDARY);
    expect(excluded).toEqual([
      { record: recordRef("1").record, axis: "instance", value: "astropy__astropy-12907" },
    ]);
    expect(kept.map((r) => r.record)).toEqual([recordRef("2").record]);
  });

  it("does not normalize: a case-shifted instance id is a different id", () => {
    const { excluded } = partitionHeldOut(
      [recordRef("3", { instanceId: "ASTROPY__ASTROPY-12907", repo: "other/other" })],
      BOUNDARY,
    );
    expect(excluded).toEqual([]);
  });

  it("excludes on repo when the instance id is unseen", () => {
    const { kept, excluded } = partitionHeldOut(
      [recordRef("4", { instanceId: "astropy__astropy-99999", repo: "astropy/astropy" })],
      BOUNDARY,
    );
    expect(kept).toEqual([]);
    expect(excluded[0]).toMatchObject({ axis: "repo", value: "astropy/astropy" });
  });

  it("reports the more specific axis when a record matches both", () => {
    const { excluded } = partitionHeldOut(
      [recordRef("5", { instanceId: "astropy__astropy-12907", repo: "astropy/astropy" })],
      BOUNDARY,
    );
    expect(excluded[0]?.axis).toBe("instance");
  });

  it("refuses an unattributable record against a non-empty boundary", () => {
    const { kept, excluded } = partitionHeldOut([recordRef("6")], BOUNDARY);
    expect(kept).toEqual([]);
    expect(excluded[0]).toEqual({ record: recordRef("6").record, axis: "unattributable", value: "" });
  });

  it("keeps an unattributable record against an empty boundary — there is nothing to be outside of", () => {
    const empty = { ...BOUNDARY, instanceIds: [], repos: [] };
    const { kept, excluded } = partitionHeldOut([recordRef("6")], empty);
    expect(excluded).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it("preserves the query's order in what it keeps", () => {
    const records = ["9", "8", "7"].map((seed) => recordRef(seed, { repo: "keep/keep" }));
    expect(partitionHeldOut(records, BOUNDARY).kept.map((r) => r.record))
      .toEqual(records.map((r) => r.record));
  });
});

describe("assertValidRecordRefs", () => {
  it("refuses a malformed digest", () => {
    expect(() => assertValidRecordRefs([{ record: "deadbeef" }], "records"))
      .toThrow(PolicyOptimizationError);
  });

  it("refuses a repeated record: one record counted twice is not a longer bundle", () => {
    expect(() => assertValidRecordRefs([recordRef("1"), recordRef("1")], "records"))
      .toThrow(/duplicate record reference/);
  });

  it("refuses an empty-string attribution member", () => {
    expect(() => assertValidRecordRefs([{ record: recordRef("1").record, repo: "" }], "records"))
      .toThrow(/repo must be a non-empty string/);
  });
});

describe("scanLexical", () => {
  it("finds an identifier and reports it, sorted", () => {
    expect(scanLexical("we studied django/django and astropy/astropy", BOUNDARY))
      .toEqual(["astropy/astropy", "django/django"]);
  });

  it("is case-insensitive", () => {
    expect(scanLexical("See ASTROPY__Astropy-12907 for the fix.", BOUNDARY))
      .toEqual(["astropy__astropy-12907"]);
  });

  it("over-matches to the right: a suffixed identifier is still a leak", () => {
    expect(scanLexical("apply astropy__astropy-12907.patch", BOUNDARY))
      .toEqual(["astropy__astropy-12907"]);
  });

  it("does not match with an identifier character to the left", () => {
    expect(scanLexical("xastropy/astropy", BOUNDARY)).toEqual([]);
    expect(scanLexical("_django/django", BOUNDARY)).toEqual([]);
  });

  it("still matches when a later occurrence is clean", () => {
    expect(scanLexical("xdjango/django and then django/django", BOUNDARY))
      .toEqual(["django/django"]);
  });

  it("returns nothing for clean text, an empty boundary, or empty text", () => {
    expect(scanLexical("a wholly unrelated sentence", BOUNDARY)).toEqual([]);
    expect(scanLexical("astropy/astropy", { ...BOUNDARY, lexicalIdentifiers: [] })).toEqual([]);
    expect(scanLexical("", BOUNDARY)).toEqual([]);
  });
});
