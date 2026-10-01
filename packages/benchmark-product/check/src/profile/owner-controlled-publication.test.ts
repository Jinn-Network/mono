// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3401: the sixth sealed venue sentence, declared as the `/10` capability
 * `owner-controlled-publication` (operator ruling of 2026-09-24).
 *
 * A bundle that declares it seals the sentence right after the five, in the Report limitations and
 * in `venueHonesty.limits`, and carries it as its claim section. A bundle that does not declare it
 * keeps the five sentences byte for byte. Both directions are refused where they disagree: the
 * sentence without the declaration, and the declaration without the sentence.
 */

import { describe, expect, test } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  type BenchmarkRecord,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { OWNER_CONTROLLED_PUBLICATION_CAPABILITY } from "../capabilities.js";
import { anchoredVenueLimits, type ClaimAnchor } from "./anchor-claims.js";
import { assertClaimConsistency, type ClaimRecordIdentities } from "./claim-consistency.js";
import { buildClaimPackage, ClaimPackageSchema, type ClaimPackage } from "./claim.js";
import { BenchmarkProductError } from "./errors.js";
import { IMPORTED_RUN_PINNING_LIMIT } from "./external-import.js";
import { INSPECT_OCI_ISOLATION_POLICY } from "./isolation.js";
import { OWNER_CONTROLLED_PUBLICATION_LIMIT } from "./owner-controlled-publication.js";
import { LOCAL_VENUE_LIMITS, buildLocalVenueHonesty, localVenueLimitsForRun } from "./run-results.js";

const OCP = OWNER_CONTROLLED_PUBLICATION_CAPABILITY;
const digest = (fill: string) => fill.repeat(64);
const DRAFT_ID = "draft-1";
const ASSURANCE_PRESET = "direct-check";
const RESOLVED_ASSURANCE = {
  independence: "disclosed",
  minVerdicts: 1,
  distinctEvaluator: false,
  verdictRule: "sole",
} as const;

const runRecord = {
  arms: [{ armId: "armA", pinning: {} }],
  replicates: 1,
  policy: {
    independence: RESOLVED_ASSURANCE.independence,
    evaluation: { minVerdicts: RESOLVED_ASSURANCE.minVerdicts, distinctEvaluator: RESOLVED_ASSURANCE.distinctEvaluator },
    submissionBaseline: {},
  },
  analysisPlan: [{
    method: BENCHMARKING_METHOD_IDS.wilson,
    version: BENCHMARKING_METHOD_VERSION,
    parameters: { verdictRule: RESOLVED_ASSURANCE.verdictRule },
  }],
} as unknown as RunRecord;

const multiPolicyRun = {
  ...runRecord,
  policy: { ...runRecord.policy, submissionBaseline: { isolationPolicy: INSPECT_OCI_ISOLATION_POLICY } },
} as unknown as RunRecord;

const matrixRecord = {
  cells: [{
    cellKey: `${digest("1")}/armA/1`,
    taskDigest: digest("1"),
    armId: "armA",
    replicate: 1,
    outcome: "judged",
    verification: { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] },
    integrityTier: "re-derivable",
  }],
  completeness: { expected: 1, judged: 1, floor: "1", runOutcome: "complete" },
  attrition: {
    perArm: {
      armA: { expected: 1, judged: 1, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0 },
    },
    asymmetryFlags: [],
  },
} as unknown as MatrixRecord;

function reportWith(limitations: readonly string[]): ReportRecord {
  return {
    method: { id: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
    preregistered: false,
    results: {
      perSubject: [{
        results: {
          arms: { armA: { n: 1, passRate: "1", wilsonInterval: { low: "0.207", high: "1" } } },
          conflicted: { count: 0, cellKeys: [] },
        },
      }],
    },
    disclosures: { perSubject: [] },
    limitations: [...limitations],
  } as unknown as ReportRecord;
}

const identities: ClaimRecordIdentities = {
  benchmarkSha256: digest("b"),
  runSha256: digest("c"),
  matrixSha256: digest("d"),
  reportSha256: digest("e"),
  reportEnvelopeSha256: digest("f"),
};

const LOCK_ANCHOR: ClaimAnchor = {
  subject: "lock",
  kind: "rfc3161",
  provider: "test-authority",
  recordSha256: digest("7"),
  facts: { genTime: "2026-09-01T00:00:00Z", policyOid: "1.2.3.4", serialNumber: "01", signerCertificateSha256: digest("8") },
};

const MATRIX_ANCHOR: ClaimAnchor = {
  subject: "matrix",
  kind: "opentimestamps",
  provider: "test-calendar",
  recordSha256: digest("9"),
  facts: { blockHeight: 900_000 },
};

/** A claim built the way a producer builds it: `declared` decides the sixth sentence and the
 * section together, as `report` derives both from the one vector. */
function claimFor(input: {
  readonly composedCapabilities?: readonly string[];
  readonly declared: boolean;
  readonly report: ReportRecord;
}): ClaimPackage {
  return buildClaimPackage({
    draftId: DRAFT_ID,
    benchmarkSha256: identities.benchmarkSha256,
    runRecord,
    runSha256: identities.runSha256,
    matrixRecord,
    matrixSha256: identities.matrixSha256,
    reportRecord: input.report,
    reportSha256: identities.reportSha256!,
    reportEnvelopeSha256: identities.reportEnvelopeSha256,
    venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, [], undefined, false, input.declared),
    verificationCommandVerb: "bundle verify",
    assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
    ...(input.composedCapabilities === undefined ? {} : { composedCapabilities: input.composedCapabilities }),
    ...(input.declared ? { ownerControlledPublication: OWNER_CONTROLLED_PUBLICATION_LIMIT } : {}),
  });
}

/** The verifier's side: the vector is the bundle's, never the claim's. */
function verify(claim: ClaimPackage, bundle: { readonly composedCapabilities?: readonly string[]; readonly report: ReportRecord }): void {
  assertClaimConsistency({
    claim,
    identities,
    benchmarkRecord: {} as unknown as BenchmarkRecord,
    runRecord,
    matrixRecord,
    reportRecord: bundle.report,
    draftId: DRAFT_ID,
    assurancePreset: ASSURANCE_PRESET,
    ...(bundle.composedCapabilities === undefined ? {} : { composedCapabilities: bundle.composedCapabilities }),
  });
}

function refusalOf(run: () => void): BenchmarkProductError {
  try {
    run();
  } catch (cause) {
    if (cause instanceof BenchmarkProductError) return cause;
    throw cause;
  }
  throw new Error("expected a typed refusal");
}

const FIVE = [...LOCAL_VENUE_LIMITS];
const SIX = [...LOCAL_VENUE_LIMITS, OWNER_CONTROLLED_PUBLICATION_LIMIT];

describe("the sentence", () => {
  test("is the ruling's wording, byte for byte", () => {
    expect(OWNER_CONTROLLED_PUBLICATION_LIMIT).toBe(
      "This venue's publication source is owner-controlled and has no witness: the owner holds its signing key and hosts its archive, so it can rewrite what it published before a reader first fetches it, and only a reader who kept an earlier copy can detect a later rewrite.",
    );
    // A straight apostrophe, and nothing outside ASCII: a typographic quote would be another sentence.
    expect([...OWNER_CONTROLLED_PUBLICATION_LIMIT].every((character) => character.charCodeAt(0) < 0x80)).toBe(true);
    expect(OWNER_CONTROLLED_PUBLICATION_LIMIT).toContain("venue's");
  });

  test("is not one of the five, and the five are unchanged", () => {
    expect(LOCAL_VENUE_LIMITS).toHaveLength(5);
    expect(LOCAL_VENUE_LIMITS).not.toContain(OWNER_CONTROLLED_PUBLICATION_LIMIT);
  });
});

describe("composing the sixth sentence with the venue sentences", () => {
  test("not declared: the five, as the same array, byte for byte", () => {
    expect(localVenueLimitsForRun(runRecord)).toBe(LOCAL_VENUE_LIMITS);
    expect(localVenueLimitsForRun(runRecord, false, false)).toBe(LOCAL_VENUE_LIMITS);
  });

  test("declared: appended after the five", () => {
    expect(localVenueLimitsForRun(runRecord, false, true)).toEqual(SIX);
  });

  test("declared on an imported run: after the import-aware five", () => {
    expect(localVenueLimitsForRun(runRecord, true, true)).toEqual([
      LOCAL_VENUE_LIMITS[0],
      LOCAL_VENUE_LIMITS[1],
      IMPORTED_RUN_PINNING_LIMIT,
      LOCAL_VENUE_LIMITS[3],
      LOCAL_VENUE_LIMITS[4],
      OWNER_CONTROLLED_PUBLICATION_LIMIT,
    ]);
  });

  test("declared on a multi-policy venue: after the five with the multi-policy pinning sentence", () => {
    const five = localVenueLimitsForRun(multiPolicyRun);
    expect(five).toHaveLength(5);
    expect(localVenueLimitsForRun(multiPolicyRun, false, true)).toEqual([...five, OWNER_CONTROLLED_PUBLICATION_LIMIT]);
  });

  test("anchoring rewrites the pre-registration sentence and appends its lines after the sixth", () => {
    const anchors = [LOCK_ANCHOR, MATRIX_ANCHOR];
    const undeclared = anchoredVenueLimits(localVenueLimitsForRun(runRecord), anchors);
    const declared = anchoredVenueLimits(localVenueLimitsForRun(runRecord, false, true), anchors);
    expect(declared).toEqual([...undeclared.slice(0, 5), OWNER_CONTROLLED_PUBLICATION_LIMIT, ...undeclared.slice(5)]);
    expect(declared[1]).not.toBe(LOCAL_VENUE_LIMITS[1]);
    expect(buildLocalVenueHonesty(matrixRecord.cells, runRecord, anchors, undefined, false, true).limits).toEqual(declared);
    expect(buildLocalVenueHonesty(matrixRecord.cells, runRecord, anchors).limits).toEqual(undeclared);
  });
});

describe("claim-consistency on a composed bundle", () => {
  test("declared, with the sentence in the Report, the venue sentences, and the section: consistent", () => {
    const report = reportWith(SIX);
    const claim = claimFor({ composedCapabilities: [OCP], declared: true, report });
    expect(claim.ownerControlledPublication).toBe(OWNER_CONTROLLED_PUBLICATION_LIMIT);
    expect(claim.venueHonesty).toEqual(expect.objectContaining({ limits: SIX }));
    expect(claim.limitations).toEqual(SIX);
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
    expect(() => verify(claim, { composedCapabilities: [OCP], report })).not.toThrow();
  });

  test("not declared, with the five: consistent, and the claim carries no section", () => {
    const report = reportWith(FIVE);
    const claim = claimFor({ composedCapabilities: [], declared: false, report });
    expect(claim.ownerControlledPublication).toBeUndefined();
    expect(claim.venueHonesty).toEqual(expect.objectContaining({ limits: FIVE }));
    expect(() => verify(claim, { composedCapabilities: [], report })).not.toThrow();
  });

  test("the sentence without the declaration is refused on the claim", () => {
    const report = reportWith(SIX);
    const claim = claimFor({ composedCapabilities: [OCP], declared: true, report });
    const refusal = refusalOf(() => verify(claim, { composedCapabilities: [], report }));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.message).toMatch(/claim package (ownerControlledPublication|venueHonesty\.limits\.5) is not the exact projection/u);
  });

  test("the sentence in the venue sentences alone, with no section and no declaration, is refused", () => {
    const report = reportWith(FIVE);
    const claim = claimFor({ composedCapabilities: [], declared: false, report });
    const smuggled = { ...claim, venueHonesty: { ...(claim.venueHonesty as object), limits: SIX } } as ClaimPackage;
    expect(refusalOf(() => verify(smuggled, { composedCapabilities: [], report })).message)
      .toMatch(/claim package venueHonesty\.limits is not the exact projection/u);
  });

  test("the sentence in the sealed Report without the declaration is refused on the Report", () => {
    const report = reportWith(SIX);
    const claim = claimFor({ composedCapabilities: [], declared: false, report });
    const refusal = refusalOf(() => verify(claim, { composedCapabilities: [], report }));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.message).toContain("does not declare owner-controlled-publication");
  });

  test("the declaration without the sentence in the claim is refused on the claim", () => {
    const report = reportWith(SIX);
    const claim = claimFor({ composedCapabilities: [], declared: false, report });
    const refusal = refusalOf(() => verify(claim, { composedCapabilities: [OCP], report }));
    expect(refusal.message).toMatch(/claim package (claimSchema|ownerControlledPublication|venueHonesty\.limits) is not the exact projection/u);
  });

  test("the declaration without the sentence in the sealed Report is refused on the Report", () => {
    // Everything the claim carries is right; only the signed Report omits the sentence.
    const report = reportWith(FIVE);
    const claim = claimFor({ composedCapabilities: [OCP], declared: true, report });
    const refusal = refusalOf(() => verify(claim, { composedCapabilities: [OCP], report }));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.message).toContain("must seal the publication-source sentence in its Report limitations");
  });

  test("the sentence sealed anywhere but right after the venue sentences is refused", () => {
    const report = reportWith([...FIVE, "Another limitation.", OWNER_CONTROLLED_PUBLICATION_LIMIT]);
    const claim = claimFor({ composedCapabilities: [OCP], declared: true, report });
    expect(refusalOf(() => verify(claim, { composedCapabilities: [OCP], report })).message)
      .toContain("right after the venue sentences");
  });
});

describe("claim-consistency on a pre-composition bundle", () => {
  test("an earlier format carries the five and verifies as before", () => {
    const report = reportWith(FIVE);
    expect(() => verify(claimFor({ declared: false, report }), { report })).not.toThrow();
  });

  test("an earlier format cannot declare the capability, so the sentence in its Report is refused", () => {
    const report = reportWith(SIX);
    expect(refusalOf(() => verify(claimFor({ declared: false, report }), { report })).message)
      .toContain("does not declare owner-controlled-publication");
  });
});

describe("the claim section", () => {
  test("the builder refuses a declaration and a section that do not arrive together", () => {
    const report = reportWith(SIX);
    const build = (composedCapabilities: readonly string[], section: boolean) => () => buildClaimPackage({
      draftId: DRAFT_ID,
      benchmarkSha256: identities.benchmarkSha256,
      runRecord,
      runSha256: identities.runSha256,
      matrixRecord,
      matrixSha256: identities.matrixSha256,
      reportRecord: report,
      reportSha256: identities.reportSha256!,
      reportEnvelopeSha256: identities.reportEnvelopeSha256,
      venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, [], undefined, false, true),
      verificationCommandVerb: "bundle verify",
      assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
      composedCapabilities,
      ...(section ? { ownerControlledPublication: OWNER_CONTROLLED_PUBLICATION_LIMIT } : {}),
    });
    expect(build([OCP], false)).toThrow(/"owner-controlled-publication" and its "ownerControlledPublication" section/u);
    expect(build([], true)).toThrow(/"owner-controlled-publication" and its "ownerControlledPublication" section/u);
    expect(build([OCP], true)).not.toThrow();
  });

  test("only a composed claim carries it, and only with the ruled wording", () => {
    const report = reportWith(SIX);
    const composed = claimFor({ composedCapabilities: [OCP], declared: true, report });
    const issuesOf = (claim: unknown): string[] => {
      const parsed = ClaimPackageSchema.safeParse(claim);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    expect(issuesOf(composed)).toEqual([]);
    expect(issuesOf({ ...composed, ownerControlledPublication: `${OWNER_CONTROLLED_PUBLICATION_LIMIT} ` })).not.toEqual([]);
    expect(issuesOf({ ...composed, ownerControlledPublication: OWNER_CONTROLLED_PUBLICATION_LIMIT.replace("'", "’") }))
      .not.toEqual([]);
    const legacy = claimFor({ declared: false, report: reportWith(FIVE) });
    expect(issuesOf(legacy)).toEqual([]);
    expect(issuesOf({ ...legacy, ownerControlledPublication: OWNER_CONTROLLED_PUBLICATION_LIMIT }))
      .toEqual([expect.stringContaining("only the composed claim-package/7 allocation carries an ownerControlledPublication section")]);
  });
});
