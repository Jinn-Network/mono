// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
} from "@jinn-network/trust-core";
import type { AnchorProofResult, AnchorProofVerifier } from "@jinn-network/trust-core";

import { bytesToHex } from "./der-encoder.js";
import {
  anchorProofContractCases,
  createAnchorKitFixtures,
  describeAnchorProofVerifierContract,
  runAnchorProofContractCases,
} from "./conformance.js";
import type { AnchorProofContractCase } from "./conformance.js";

// ---------------------------------------------------------------------------
// A conformance suite that cannot fail is no gate, so this file's job is to
// prove that this one can -- and fails on exactly the cases it should.
//
// Three trivial verifiers stand in for the ways an implementation can be wrong
// without being obviously broken: one that refuses everything, one that accepts
// everything, and one that calls everything pending. Each is run through the
// suite's own pure runner and the failing case names are asserted exactly. The
// fourth verifier is an oracle built from the case list itself; it exists to
// show the runner and the vitest wrapper report a correct implementation green,
// and it proves nothing about verification, which is why it is never the only
// verifier here.
// ---------------------------------------------------------------------------

const kit = createAnchorKitFixtures();
const cases = anchorProofContractCases(kit);

const KIT_TRUST = { kit: true } as const;
type KitTrust = typeof KIT_TRUST | undefined;

function stubVerifier(
  profile: string,
  answer: (input: { readonly trust?: KitTrust }) => AnchorProofResult,
): AnchorProofVerifier<unknown, KitTrust> {
  return {
    profile,
    timeBasis: profile === RFC3161_TSA_ANCHOR_PROFILE ? "authority-time" : "chain-time",
    posture: profile === RFC3161_TSA_ANCHOR_PROFILE
      ? "offline-from-artifact"
      : "offline-with-external-data",
    verifyProof: (input) => answer({ trust: input.trust }),
  };
}

function casesFor(profile: string): readonly AnchorProofContractCase[] {
  return cases.filter((testCase) => testCase.profile === profile);
}

function failingNames(
  profile: string,
  answer: (input: { readonly trust?: KitTrust }) => AnchorProofResult,
): readonly string[] {
  return runAnchorProofContractCases(
    stubVerifier(profile, answer),
    KIT_TRUST,
    casesFor(profile),
  ).map((failure) => failure.case).sort();
}

function expectedNames(profile: string, predicate: (testCase: AnchorProofContractCase) => boolean) {
  return casesFor(profile).filter(predicate).map((testCase) => testCase.name).sort();
}

const PROFILES = [RFC3161_TSA_ANCHOR_PROFILE, OPENTIMESTAMPS_ANCHOR_PROFILE];

describe("the case inventory", () => {
  test("both v1 provider profiles have cases, and every case is named", () => {
    for (const profile of PROFILES) {
      expect(casesFor(profile).length).toBeGreaterThan(0);
    }
    expect(cases.every((testCase) => testCase.name.length > 0)).toBe(true);
    expect(cases.every((testCase) => testCase.family.length > 0)).toBe(true);
    expect(new Set(cases.map((testCase) => testCase.profile))).toEqual(new Set(PROFILES));
  });

  test("case names are unique, so a failure names one case", () => {
    const names = cases.map((testCase) => `${testCase.profile} ${testCase.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every §6.1 rule and the parsing discipline are represented", () => {
    const families = new Set(cases.map((testCase) => testCase.family));
    for (const rule of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]) {
      expect(families).toContain(`§6.1 rule ${rule}`);
    }
    expect(families).toContain("§6.1 parsing discipline");
    // Rule 5's three layers are the algorithm floor, which §11 calls family 7.
    expect(families).toContain("§11 family 7");
    // The proof-level §11 families in this packet's scope.
    for (const family of ["§11 family 1", "§11 family 2", "§11 family 6", "§11 family 10"]) {
      expect(families).toContain(family);
    }
  });

  test("the present/verified flip is the same bytes and the same subject", () => {
    const [present, verified] = casesFor(RFC3161_TSA_ANCHOR_PROFILE);
    expect(present!.expected.status).toBe("present");
    expect(verified!.expected.status).toBe("verified");
    expect(bytesToHex(present!.proofBytes)).toBe(bytesToHex(verified!.proofBytes));
    expect(present!.subjectSha256).toBe(verified!.subjectSha256);
    expect(present!.trustMaterial).toBe("none");
    expect(verified!.trustMaterial).toBe("kit");
  });

  test("every negative runs with and without trust material", () => {
    const negatives = cases.filter((testCase) => testCase.expected.status === "invalid");
    expect(negatives.length).toBeGreaterThan(0);
    const withTrust = negatives.filter((testCase) => testCase.trustMaterial === "kit").length;
    const withoutTrust = negatives.filter((testCase) => testCase.trustMaterial === "none").length;
    // The fabricated OpenTimestamps proof is the one negative that exists only
    // on the trust-material path: without headers it is honestly `present`.
    expect(withTrust).toBe(withoutTrust + 1);
  });

  test("captured real tokens enter through the optional input", () => {
    const withReal = anchorProofContractCases(kit, {
      realTokens: [{
        name: "example",
        tokenDer: Uint8Array.of(1, 2, 3),
        subjectSha256: kit.subjectSha256,
        facts: { policyOid: "2.999.1" },
      }],
    });
    expect(withReal.length).toBe(cases.length + 2);
    expect(withReal.some((testCase) => testCase.name.includes("captured example"))).toBe(true);
  });
});

describe("the suite fails trivial verifiers on exactly the right cases", () => {
  test("a verifier that refuses everything fails every non-invalid case", () => {
    for (const profile of PROFILES) {
      const failures = failingNames(profile, () => ({
        status: "invalid",
        profile,
        reason: "stub refuses everything",
      }));
      expect(failures).toEqual(
        expectedNames(profile, (testCase) => testCase.expected.status !== "invalid"),
      );
      expect(failures.length).toBeGreaterThan(0);
    }
  });

  test("a verifier that accepts everything fails every negative case", () => {
    for (const profile of PROFILES) {
      const failures = failingNames(profile, () => ({
        status: "verified",
        profile,
        timeBasis: "authority-time",
        time: "2000-01-01T00:00:00Z",
        facts: {},
      }));
      // Every negative fails, which is the property that matters: no
      // configuration of trust material lets a permissive verifier through.
      for (const name of expectedNames(profile, (t) => t.expected.status === "invalid")) {
        expect(failures).toContain(name);
      }
      // And the positives fail too, because the facts and the evaluated time
      // are asserted rather than assumed.
      expect(failures.length).toBe(casesFor(profile).length);
    }
  });

  test("a verifier that calls everything pending fails every other case", () => {
    for (const profile of PROFILES) {
      const failures = failingNames(profile, () => ({
        status: "pending",
        profile,
        timeBasis: "authority-time",
        reason: "stub is always pending",
      }));
      expect(failures).toEqual(
        expectedNames(profile, (testCase) => testCase.expected.status !== "pending"),
      );
    }
  });

  test("a verifier that ignores the trust material fails the flip", () => {
    // The sharpest trivial failure: internally consistent answers that never
    // look at what the caller supplied. The `present`/`verified` pair is one
    // token, one subject, two calls -- so this verifier cannot satisfy both.
    const profile = RFC3161_TSA_ANCHOR_PROFILE;
    const valid = casesFor(profile)[0]!;
    const failures = failingNames(profile, () => ({
      status: "present",
      profile,
      timeBasis: "authority-time",
      facts: { ...valid.expected.facts },
    }));
    expect(failures).toContain("the same valid token is verified against the kit authority root");
    expect(failures).not.toContain(valid.name);
  });

  test("a verifier declaring the wrong profile fails rather than running silently", () => {
    const failures = runAnchorProofContractCases(
      stubVerifier("https://spec.jinn.network/trust/anchor-profiles/other/v1", () => ({
        status: "invalid",
        profile: "https://spec.jinn.network/trust/anchor-profiles/other/v1",
        reason: "stub",
      })),
      KIT_TRUST,
      casesFor(RFC3161_TSA_ANCHOR_PROFILE),
    );
    expect(failures.length).toBe(casesFor(RFC3161_TSA_ANCHOR_PROFILE).length);
    expect(failures[0]!.reason).toContain("declares profile");
  });

  test("a verifier that throws is a failure, not an escape", () => {
    const profile = RFC3161_TSA_ANCHOR_PROFILE;
    const failures = runAnchorProofContractCases(
      stubVerifier(profile, () => {
        throw new Error("boom");
      }),
      KIT_TRUST,
      casesFor(profile),
    );
    expect(failures.length).toBe(casesFor(profile).length);
    expect(failures[0]!.reason).toContain("verifyProof threw");
  });

  test("a present result that reports an evaluated time is a failure", () => {
    const profile = RFC3161_TSA_ANCHOR_PROFILE;
    const presentCase = casesFor(profile)[0]!;
    const failures = runAnchorProofContractCases(
      stubVerifier(profile, () => ({
        status: "present",
        profile,
        timeBasis: "authority-time",
        time: "2026-08-17T12:00:00Z",
        facts: { ...presentCase.expected.facts },
      } as AnchorProofResult)),
      KIT_TRUST,
      [presentCase],
    );
    expect(failures.map((failure) => failure.reason))
      .toEqual(["a present result must not report an evaluated time"]);
  });
});

// ---------------------------------------------------------------------------
// The oracle: an implementation-shaped stand-in that answers each case with the
// outcome the case declares. It proves the runner and the vitest wrapper report
// a correct verifier green -- and nothing else. The real verifiers land in the
// provider packets.
// ---------------------------------------------------------------------------

function oracleVerifier(profile: string): AnchorProofVerifier<unknown, KitTrust> {
  const answers = new Map<string, AnchorProofResult>();
  for (const testCase of cases.filter((entry) => entry.profile === profile)) {
    const key = `${bytesToHex(testCase.proofBytes)}|${testCase.subjectSha256}|${testCase.trustMaterial}`;
    const { expected } = testCase;
    answers.set(
      key,
      expected.status === "verified"
        ? {
          status: "verified",
          profile,
          timeBasis: expected.timeBasis!,
          time: expected.time!,
          facts: expected.facts ?? {},
        }
        : expected.status === "present"
          ? {
            status: "present",
            profile,
            timeBasis: expected.timeBasis!,
            facts: expected.facts ?? {},
          }
          : expected.status === "pending"
            ? {
              status: "pending",
              profile,
              timeBasis: expected.timeBasis ?? "authority-time",
              reason: "oracle",
            }
            : { status: "invalid", profile, reason: "oracle" },
    );
  }
  return {
    profile,
    timeBasis: profile === RFC3161_TSA_ANCHOR_PROFILE ? "authority-time" : "chain-time",
    posture: profile === RFC3161_TSA_ANCHOR_PROFILE
      ? "offline-from-artifact"
      : "offline-with-external-data",
    verifyProof: (input) => {
      const key = `${bytesToHex(input.proofBytes)}|${input.subjectSha256}|${input.trust === undefined ? "none" : "kit"}`;
      return answers.get(key)
        ?? { status: "invalid", profile, reason: "the oracle has no answer for these bytes" };
    },
  };
}

describe("the harness executes", () => {
  test("the oracle passes every case, so a failure above is discrimination", () => {
    for (const profile of PROFILES) {
      expect(runAnchorProofContractCases(oracleVerifier(profile), KIT_TRUST, casesFor(profile)))
        .toEqual([]);
    }
  });
});

// The exported vitest suite, run for real against the oracle: this is the
// plumbing check -- `describe`/`beforeEach`/`test` registration, profile
// filtering, and the per-case assertion body all execute here, so a consumer in
// P4 or P5 gets a suite that has already been run end to end.
describeAnchorProofVerifierContract(RFC3161_TSA_ANCHOR_PROFILE, () => ({
  verifier: oracleVerifier(RFC3161_TSA_ANCHOR_PROFILE),
  trust: KIT_TRUST,
}));

describeAnchorProofVerifierContract(OPENTIMESTAMPS_ANCHOR_PROFILE, () => ({
  verifier: oracleVerifier(OPENTIMESTAMPS_ANCHOR_PROFILE),
  trust: KIT_TRUST,
}));
