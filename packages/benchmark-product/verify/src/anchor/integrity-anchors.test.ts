// SPDX-License-Identifier: Apache-2.0

/**
 * The `integrity-anchors` check against the conformance kit's fixture families (anchor-evidence
 * design §11), plus the claim projection those families gate.
 *
 * Family 1 (valid complete anchor), 2 (tampered proof), 6 (pending), and 7 (algorithm floor) are
 * exercised over the profile verifiers by the kit's own parameterized contract suite, which this
 * package already runs in `rfc3161-contract.test.ts`. What is tested here is what this check adds
 * on top of a proof verifier: subject recomputation, kind equality, the trust-material split, the
 * splice-catch, per-subject absence semantics, and the honesty copy those byte-facts gate.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MATRIX_RECORD_KIND, RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { createHash } from "node:crypto";
import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
} from "@jinn-network/trust-core";
import {
  KIT_BITCOIN_BLOCK_TIME,
  buildAnchorEvidenceRecord,
  buildOpenTimestampsAnchorEvidenceRecord,
  buildRfc3161AnchorEvidenceRecord,
  createFixtureAuthority,
  createOpenTimestampsKitFixtures,
} from "@jinn-network/trust-testing";
import { evaluateIntegrityAnchors } from "./check.js";
import {
  anchoredVenueLimits,
  deriveClaimAnchors,
  governingLockAnchors,
} from "../profile/anchor-claims.js";
import { LOCAL_VENUE_LIMITS } from "../profile/run-results.js";

const require = createRequire(import.meta.url);

const RUN_SHA256 = "1".repeat(64);
const MATRIX_SHA256 = "2".repeat(64);
const UNRELATED_SHA256 = "3".repeat(64);
const CLOSE_AT = "2026-06-01T00:00:00Z";
const GEN_TIME_DER = "20260501120000Z";
const GEN_TIME = "2026-05-01T12:00:00Z";
const LATER_GEN_TIME_DER = "20260601120000Z";

const authority = createFixtureAuthority("integrity-anchors");
const lockOts = createOpenTimestampsKitFixtures(hexToBytes(RUN_SHA256));
const matrixOts = createOpenTimestampsKitFixtures(hexToBytes(MATRIX_SHA256));

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function carried(built: { readonly bytes: Uint8Array; readonly recordDigest: string }) {
  return { recordSha256: built.recordDigest.slice("sha256:".length), bytes: built.bytes };
}

function rfc3161Lock(options: { readonly genTimeDer?: string; readonly subjectSha256?: string } = {}) {
  const subjectSha256 = options.subjectSha256 ?? RUN_SHA256;
  return carried(buildRfc3161AnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256,
    proofBytes: authority.mintTimeStampToken({
      subjectSha256,
      genTime: options.genTimeDer ?? GEN_TIME_DER,
    }).tokenDer,
  }));
}

function evaluate(records: readonly { recordSha256: string; bytes: Uint8Array }[], extra: {
  readonly declaredProfiles?: readonly string[];
  readonly trust?: Parameters<typeof evaluateIntegrityAnchors>[0]["trust"];
} = {}) {
  return evaluateIntegrityAnchors({
    records,
    runSha256: RUN_SHA256,
    matrixSha256: MATRIX_SHA256,
    closeAt: CLOSE_AT,
    ...extra,
  });
}

describe("integrity-anchors — trust material is verifier-side", () => {
  test("a valid complete anchor is present without material and verified with it (family 1)", () => {
    const record = rfc3161Lock();

    const without = evaluate([record]);
    expect(without.anchors[0]!.status).toBe("present");
    expect(without.anchors[0]!.trustMaterial).toBe("none");
    expect(without.anchors[0]!.time).toBeUndefined();
    expect(without.invalid).toHaveLength(0);

    const with_ = evaluate([record], { trust: { rfc3161: { trustAnchorsDer: [authority.certificateDer] } } });
    expect(with_.anchors[0]!.status).toBe("verified");
    expect(with_.anchors[0]!.trustMaterial).toBe("supplied");
    expect(with_.anchors[0]!.time).toBe(GEN_TIME);
  });

  test("the sealed claim projection is identical either way — text keys on bytes, not on trust", () => {
    const record = rfc3161Lock();
    const anchors = deriveClaimAnchors({ records: [record], runSha256: RUN_SHA256, matrixSha256: MATRIX_SHA256 });
    expect(anchors[0]!.facts).toEqual({
      genTime: GEN_TIME,
      policyOid: expect.any(String),
      serialNumber: expect.any(String),
      signerCertificateSha256: authority.certificateSha256,
    });
    expect(anchoredVenueLimits(LOCAL_VENUE_LIMITS, anchors)[1]).toContain(
      `existed no later than ${GEN_TIME}`,
    );
  });
});

describe("integrity-anchors — subject recomputation (families 3 and 4)", () => {
  test("a dangling anchor is invalid, louder than absence", () => {
    const record = rfc3161Lock({ subjectSha256: UNRELATED_SHA256 });
    const report = evaluate([record]);
    expect(report.anchors[0]!.status).toBe("invalid");
    expect(report.anchors[0]!.reason).toContain(UNRELATED_SHA256);
    expect(report.invalid).toHaveLength(1);
    // The subject is unknown by definition, so the entry cannot claim one.
    expect(report.anchors[0]!.subject).toBeUndefined();
    expect(report.subjects.map((entry) => entry.outcome)).toEqual(["absent", "absent"]);
  });

  test("a kind label that misdescribes the record its digest resolves to is invalid", () => {
    const record = carried(buildRfc3161AnchorEvidenceRecord({
      // The digest resolves to the sealed Run; the label says Matrix.
      subjectKind: MATRIX_RECORD_KIND,
      subjectSha256: RUN_SHA256,
      proofBytes: authority.mintTimeStampToken({ subjectSha256: RUN_SHA256, genTime: GEN_TIME_DER }).tokenDer,
    }));
    const report = evaluate([record]);
    expect(report.anchors[0]!.status).toBe("invalid");
    expect(report.anchors[0]!.reason).toContain(RUN_RECORD_KIND);
    // Selection was digest-keyed, so the label never routed it onto the Matrix claim.
    expect(report.anchors[0]!.subject).toBe("lock");
  });

  test("a provider profile no verifier implements is invalid, by name", () => {
    const record = carried(buildAnchorEvidenceRecord({
      subjectKind: RUN_RECORD_KIND,
      subjectSha256: RUN_SHA256,
      provider: "https://spec.jinn.network/trust/anchor-profiles/not-implemented/v1",
      proofMediaType: "application/octet-stream",
      proofBytes: Uint8Array.of(1, 2, 3, 4),
    }));
    const report = evaluate([record]);
    expect(report.anchors[0]!.status).toBe("invalid");
    expect(report.anchors[0]!.reason).toContain("not-implemented/v1");
  });
});

describe("integrity-anchors — absence semantics (family 5)", () => {
  test("no carried anchor reports absent for both subjects and passes", () => {
    const report = evaluate([]);
    expect(report.invalid).toHaveLength(0);
    expect(report.subjects).toEqual([
      { subject: "lock", outcome: "absent" },
      { subject: "matrix", outcome: "absent" },
    ]);
  });

  test("declared intent with no matching anchor is a distinct disclosure", () => {
    const report = evaluate([], { declaredProfiles: [RFC3161_TSA_ANCHOR_PROFILE] });
    expect(report.invalid).toHaveLength(0);
    expect(report.subjects[0]).toEqual({
      subject: "lock",
      outcome: "declared-but-absent",
      declaredProfiles: [RFC3161_TSA_ANCHOR_PROFILE],
    });
    // The Matrix was never declared, so its absence stays a clean absence.
    expect(report.subjects[1]!.outcome).toBe("absent");
  });

  test("a declared profile that is carried reports anchored; a second declared one still surfaces", () => {
    const report = evaluate([rfc3161Lock()], {
      declaredProfiles: [OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE],
    });
    expect(report.subjects[0]).toEqual({
      subject: "lock",
      outcome: "declared-but-absent",
      declaredProfiles: [OPENTIMESTAMPS_ANCHOR_PROFILE],
    });

    const satisfied = evaluate([rfc3161Lock()], { declaredProfiles: [RFC3161_TSA_ANCHOR_PROFILE] });
    expect(satisfied.subjects[0]).toEqual({ subject: "lock", outcome: "anchored" });
  });
});

describe("integrity-anchors — the splice-catch (family 8)", () => {
  test("an authority-time lock anchor at or before closeAt passes", () => {
    expect(evaluate([rfc3161Lock({ genTimeDer: GEN_TIME_DER })]).invalid).toHaveLength(0);
  });

  test("an authority-time lock anchor after closeAt is invalid", () => {
    const report = evaluate([rfc3161Lock({ genTimeDer: LATER_GEN_TIME_DER })]);
    expect(report.anchors[0]!.status).toBe("invalid");
    expect(report.anchors[0]!.reason).toContain("after this run's own pre-registered close instant");
  });

  test("the catch fires on the no-roots default path, where facts.genTime is the only time", () => {
    const report = evaluate([rfc3161Lock({ genTimeDer: LATER_GEN_TIME_DER })]);
    expect(report.anchors[0]!.trustMaterial).toBe("none");
    expect(report.invalid).toHaveLength(1);
  });

  test("a matrix anchor is not subject to the catch — it says nothing about dispatch order", () => {
    const record = carried(buildRfc3161AnchorEvidenceRecord({
      subjectKind: MATRIX_RECORD_KIND,
      subjectSha256: MATRIX_SHA256,
      proofBytes: authority.mintTimeStampToken({
        subjectSha256: MATRIX_SHA256,
        genTime: LATER_GEN_TIME_DER,
      }).tokenDer,
    }));
    const report = evaluate([record]);
    expect(report.anchors[0]!.status).toBe("present");
    expect(report.invalid).toHaveLength(0);
  });

  test("a chain-time lock anchor carries no time and the catch does not reach it", () => {
    const record = carried(buildOpenTimestampsAnchorEvidenceRecord({
      subjectKind: RUN_RECORD_KIND,
      subjectSha256: RUN_SHA256,
      proofBytes: lockOts.completeProof,
    }));
    const report = evaluate([record]);
    expect(report.anchors[0]!.status).toBe("present");
    expect(report.anchors[0]!.timeBasis).toBe("chain-time");
    expect(report.invalid).toHaveLength(0);
  });
});

describe("integrity-anchors — the upgraded pair (family 9)", () => {
  const pending = carried(buildOpenTimestampsAnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256: RUN_SHA256,
    proofBytes: lockOts.pendingProof,
  }));
  const complete = carried(buildOpenTimestampsAnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256: RUN_SHA256,
    proofBytes: lockOts.completeProof,
  }));

  test("each record is reported on its own bytes", () => {
    const report = evaluate([pending, complete]);
    expect(report.invalid).toHaveLength(0);
    const byDigest = new Map(report.anchors.map((entry) => [entry.recordSha256, entry]));
    expect(byDigest.get(pending.recordSha256)!.status).toBe("pending");
    expect(byDigest.get(complete.recordSha256)!.status).toBe("present");
    expect(report.subjects[0]!.outcome).toBe("anchored");
  });

  test("the completed one governs the copy and names the pending one it upgrades", () => {
    const anchors = deriveClaimAnchors({
      records: [pending, complete],
      runSha256: RUN_SHA256,
      matrixSha256: MATRIX_SHA256,
    });
    const governing = governingLockAnchors(anchors);
    expect(governing).toHaveLength(1);
    expect(governing[0]!.recordSha256).toBe(complete.recordSha256);
    expect(anchors.find((entry) => entry.recordSha256 === complete.recordSha256)!.upgradesRecordSha256)
      .toBe(pending.recordSha256);
    expect(anchors.find((entry) => entry.recordSha256 === pending.recordSha256)!.upgradesRecordSha256)
      .toBeUndefined();
  });

  test("a pending-only bundle gates no text at all (family 6, the copy half)", () => {
    const anchors = deriveClaimAnchors({
      records: [pending],
      runSha256: RUN_SHA256,
      matrixSha256: MATRIX_SHA256,
    });
    expect(governingLockAnchors(anchors)).toHaveLength(0);
    expect(anchoredVenueLimits(LOCAL_VENUE_LIMITS, anchors)).toEqual([...LOCAL_VENUE_LIMITS]);
  });
});

describe("integrity-anchors — fabricated chain attestation (family 10)", () => {
  const record = carried(buildOpenTimestampsAnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256: RUN_SHA256,
    proofBytes: lockOts.fabricatedCompleteProof,
  }));

  test("without headers it is present, and only the attributive copy is printed", () => {
    const report = evaluate([record]);
    expect(report.anchors[0]!.status).toBe("present");
    expect(report.invalid).toHaveLength(0);

    const anchors = deriveClaimAnchors({ records: [record], runSha256: RUN_SHA256, matrixSha256: MATRIX_SHA256 });
    const limits = anchoredVenueLimits(LOCAL_VENUE_LIMITS, anchors);
    expect(limits[1]).toContain("Checking that commitment requires Bitcoin block headers");
    // The assertive form is the authority-time one; it never prints for a chain-time anchor.
    expect(limits[1]).not.toContain("an external timestamp authority asserts");
  });

  test("with headers the invented commitment is invalid, loud", () => {
    const report = evaluate([record], {
      trust: { opentimestamps: { blockHeaders: lockOts.blockHeaders.map(({ height, header }) => ({ height, header })) } },
    });
    expect(report.anchors[0]!.status).toBe("invalid");
    expect(report.invalid).toHaveLength(1);
  });

  test("a genuine complete proof verifies against the same headers", () => {
    const genuine = carried(buildOpenTimestampsAnchorEvidenceRecord({
      subjectKind: RUN_RECORD_KIND,
      subjectSha256: RUN_SHA256,
      proofBytes: lockOts.completeProof,
    }));
    const report = evaluate([genuine], {
      trust: { opentimestamps: { blockHeaders: lockOts.blockHeaders.map(({ height, header }) => ({ height, header })) } },
    });
    expect(report.anchors[0]!.status).toBe("verified");
    expect(report.anchors[0]!.time).toBe(KIT_BITCOIN_BLOCK_TIME);
  });
});

describe("integrity-anchors — conflicting anchors (family 11)", () => {
  test("the earliest byte-embedded time governs and every other one is surfaced", () => {
    const early = rfc3161Lock({ genTimeDer: "20260301120000Z" });
    const late = rfc3161Lock({ genTimeDer: "20260401120000Z" });
    const anchors = deriveClaimAnchors({
      records: [late, early],
      runSha256: RUN_SHA256,
      matrixSha256: MATRIX_SHA256,
    });
    expect(governingLockAnchors(anchors)[0]!.recordSha256).toBe(early.recordSha256);

    const limits = anchoredVenueLimits(LOCAL_VENUE_LIMITS, anchors);
    expect(limits[1]).toContain("existed no later than 2026-03-01T12:00:00Z");
    // The contradiction is surfaced, never merged into one blended instant.
    expect(limits).toContain(
      "The lock digest additionally carries a authority-time anchor of 2026-04-01T12:00:00Z.",
    );
    expect(anchors).toHaveLength(2);
  });

  test("a time-less chain anchor never displaces a comparable authority-time one", () => {
    const rfc3161 = rfc3161Lock();
    const chain = carried(buildOpenTimestampsAnchorEvidenceRecord({
      subjectKind: RUN_RECORD_KIND,
      subjectSha256: RUN_SHA256,
      proofBytes: lockOts.completeProof,
    }));
    const anchors = deriveClaimAnchors({
      records: [chain, rfc3161],
      runSha256: RUN_SHA256,
      matrixSha256: MATRIX_SHA256,
    });
    expect(governingLockAnchors(anchors)[0]!.recordSha256).toBe(rfc3161.recordSha256);
    expect(anchoredVenueLimits(LOCAL_VENUE_LIMITS, anchors)).toContain(
      `The lock digest additionally carries a chain-time anchor of ${lockOts.blockHeight}.`,
    );
  });
});

describe("integrity-anchors — the matrix anchor (family 12)", () => {
  test("it renders its neutral line and upgrades nothing", () => {
    const record = carried(buildOpenTimestampsAnchorEvidenceRecord({
      subjectKind: MATRIX_RECORD_KIND,
      subjectSha256: MATRIX_SHA256,
      proofBytes: matrixOts.completeProof,
    }));
    const report = evaluate([record]);
    expect(report.subjects).toEqual([
      { subject: "lock", outcome: "absent" },
      { subject: "matrix", outcome: "anchored" },
    ]);

    const anchors = deriveClaimAnchors({ records: [record], runSha256: RUN_SHA256, matrixSha256: MATRIX_SHA256 });
    expect(governingLockAnchors(anchors)).toHaveLength(0);
    const limits = anchoredVenueLimits(LOCAL_VENUE_LIMITS, anchors);
    expect(limits[1]).toBe(LOCAL_VENUE_LIMITS[1]);
    expect(limits.at(-1)).toBe(
      `The terminal results digest carries a third-party time anchor of ${matrixOts.blockHeight}.`,
    );
  });
});

describe("integrity-anchors — captured production tokens", () => {
  /** The two committed real captures share one subject digest (`capture-provenance.md`). */
  const REAL_SUBJECT_SHA256 = "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c";

  function capturedToken(name: string): Uint8Array {
    return new Uint8Array(
      readFileSync(require.resolve(`@jinn-network/trust-testing/fixtures/anchor-kit-v1/${name}`)),
    );
  }

  test.each([
    ["token-digicert.der", "2026-08-17T20:37:55Z", "2.16.840.1.114412.7.1"],
    ["token-sslcom.der", "2026-08-17T20:37:56Z", "1.3.6.1.4.1.38064.1.3.6.1"],
  ])("%s projects its real byte-facts into the claim section", (name, genTime, policyOid) => {
    const record = carried(buildRfc3161AnchorEvidenceRecord({
      subjectKind: RUN_RECORD_KIND,
      subjectSha256: REAL_SUBJECT_SHA256,
      proofBytes: capturedToken(name),
    }));
    const report = evaluateIntegrityAnchors({
      records: [record],
      runSha256: REAL_SUBJECT_SHA256,
      matrixSha256: MATRIX_SHA256,
      // The captures are historical, so the run they stand in for closes after them.
      closeAt: "2026-08-18T00:00:00Z",
    });
    expect(report.anchors[0]!.status).toBe("present");
    expect(report.invalid).toHaveLength(0);

    const anchors = deriveClaimAnchors({
      records: [record],
      runSha256: REAL_SUBJECT_SHA256,
      matrixSha256: MATRIX_SHA256,
    });
    expect(anchors[0]!.facts).toMatchObject({ genTime, policyOid });
    // The section carries only the four byte-embedded facts; no issuer name, no accuracy.
    expect(Object.keys(anchors[0]!.facts).sort()).toEqual([
      "genTime",
      "policyOid",
      "serialNumber",
      "signerCertificateSha256",
    ]);
    expect(anchoredVenueLimits(LOCAL_VENUE_LIMITS, anchors)[1]).toContain(
      `existed no later than ${genTime}`,
    );
  });

  test("a captured token spliced past its run's close instant is invalid", () => {
    const record = carried(buildRfc3161AnchorEvidenceRecord({
      subjectKind: RUN_RECORD_KIND,
      subjectSha256: REAL_SUBJECT_SHA256,
      proofBytes: capturedToken("token-digicert.der"),
    }));
    const report = evaluateIntegrityAnchors({
      records: [record],
      runSha256: REAL_SUBJECT_SHA256,
      matrixSha256: MATRIX_SHA256,
      closeAt: "2026-08-17T00:00:00Z",
    });
    expect(report.anchors[0]!.status).toBe("invalid");
  });
});

describe("integrity-anchors — the record is its bytes", () => {
  test("a re-spelled record is refused rather than normalized", () => {
    const record = rfc3161Lock();
    const respelled = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(record.bytes)), null, 2),
    );
    const respelledSha256 = createHash("sha256").update(respelled).digest("hex");
    const report = evaluate([{ recordSha256: respelledSha256, bytes: respelled }]);
    expect(report.anchors[0]!.status).toBe("invalid");
    expect(report.anchors[0]!.reason).toContain("exact sealed encoding");
  });
});
