// SPDX-License-Identifier: Apache-2.0

/**
 * The parameterized anchor-proof conformance contract (design §11).
 *
 * Kits precede implementations (principles §9): this suite exists before any
 * `AnchorProofVerifier` does, and the first RFC 3161 and OpenTimestamps
 * implementations must go green against it. It follows
 * `describeTrustVerificationContract`'s shape -- one exported `describe*`
 * function an implementation's own test file calls with a factory -- with one
 * addition: the case list and the case runner are **pure**, separable from
 * vitest, so the kit's own tests can prove the suite discriminates by running it
 * against deliberately trivial verifiers and asserting exactly which cases fail.
 * A suite that cannot fail is no gate.
 *
 * Scope is the proof level: §11 families 1 (valid, and the `present`/`verified`
 * flip that proves trust material is verifier-side), 2 (tampered), 6 (pending),
 * 7 (algorithm floor), 9 (the upgraded pair, reported on its own bytes), and 10
 * (fabricated chain attestation), plus the §11 RFC 3161-specific negative list.
 * The bundle-level families -- dangling and kind-mismatched anchors, absence and
 * declared-but-absence, the `closeAt` splice-catch, conflicting anchors, the
 * matrix anchor, and text conditionality -- belong to the `integrity-anchors`
 * check (§8), which resolves subjects against an authenticated bundle snapshot;
 * they are a later packet's kit, not this one's.
 *
 * Every case is built from the deterministic builders in this directory. No case
 * reads the wall clock, the network, or the filesystem; the two captured real
 * tokens enter through the optional `realTokens` input, supplied by whoever has
 * loaded the committed bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
} from "@jinn-network/trust-core";
import type {
  AnchorProofResult,
  AnchorProofStatus,
  AnchorProofVerifier,
  AnchorTimeBasis,
} from "@jinn-network/trust-core";

import { hexToBytes } from "./der-encoder.js";
import { createFixtureAuthority } from "./fixture-authority.js";
import type {
  FixtureAuthority,
  Rfc3161ExpectedFacts,
  TimeStampTokenMutations,
} from "./fixture-authority.js";
import { KIT_BITCOIN_BLOCK_TIME, createOpenTimestampsKitFixtures } from "./ots-builder.js";
import type { OpenTimestampsKitFixtures } from "./ots-builder.js";

/**
 * The kit's subject digest: SHA-256 of the captured kit payload
 * (`fixtures/anchor-kit-v1/capture-provenance.md`). Using the captured digest
 * for the minted tokens too means the whole kit -- minted and captured -- speaks
 * about one subject, so a verifier's subject-comparison path is exercised by
 * both.
 */
export const KIT_SUBJECT_SHA256 =
  "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c";

/** A second digest no kit proof was ever minted over. */
export const KIT_UNRELATED_SUBJECT_SHA256 =
  "0000000000000000000000000000000000000000000000000000000000000001";

export const KIT_AUTHORITY_SEED = "anchor-kit-v1";

export interface AnchorKitFixtures {
  readonly subjectSha256: string;
  readonly authority: FixtureAuthority;
  readonly openTimestamps: OpenTimestampsKitFixtures;
}

/**
 * Builds the kit's fixture set. Deterministic: the same seed and subject digest
 * always produce the same bytes, on every host.
 */
export function createAnchorKitFixtures(options?: {
  readonly seed?: string;
  readonly subjectSha256?: string;
}): AnchorKitFixtures {
  const subjectSha256 = options?.subjectSha256 ?? KIT_SUBJECT_SHA256;
  return {
    subjectSha256,
    authority: createFixtureAuthority(options?.seed ?? KIT_AUTHORITY_SEED),
    openTimestamps: createOpenTimestampsKitFixtures(hexToBytes(subjectSha256)),
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface ExpectedAnchorProofOutcome {
  readonly status: AnchorProofStatus;
  readonly timeBasis?: AnchorTimeBasis;
  /** Only a `verified` result reports an evaluated instant (§4.3). */
  readonly time?: string;
  /** Asserted as a subset: every named fact must be present and equal. */
  readonly facts?: Readonly<Record<string, unknown>>;
}

export interface AnchorProofContractCase {
  readonly name: string;
  /** The §11 family (or the §6.1 rule) this case pins. */
  readonly family: string;
  readonly profile: string;
  readonly proofBytes: Uint8Array;
  readonly subjectSha256: string;
  /** `kit` supplies the implementation's own trust material built from the kit
   * fixtures; `none` supplies nothing, which is the shipped default (§8 step 3). */
  readonly trustMaterial: "kit" | "none";
  readonly expected: ExpectedAnchorProofOutcome;
}

/** One captured production token, supplied by a caller that loaded the bytes. */
export interface RealTokenInput {
  readonly name: string;
  readonly tokenDer: Uint8Array;
  readonly subjectSha256: string;
  /** The facts the capture's own provenance record states. */
  readonly facts: Partial<Rfc3161ExpectedFacts>;
}

export interface AnchorProofContractCaseOptions {
  /** Captured real tokens. Their authorities' roots are never shipped, so they
   * appear only on the no-trust-material path, where the expected outcome is
   * `present`: internally consistent, time basis not evaluated. */
  readonly realTokens?: readonly RealTokenInput[];
}

const RFC3161_NEGATIVES: readonly {
  readonly name: string;
  readonly family: string;
  readonly mutations: TimeStampTokenMutations;
}[] = [
  {
    name: "outer ContentInfo.contentType is not id-signedData",
    family: "§6.1 rule 1",
    mutations: { wrongContentType: true },
  },
  {
    name: "eContentType is not id-ct-TSTInfo",
    family: "§6.1 rule 1",
    mutations: { wrongEContentType: true },
  },
  {
    name: "TSTInfo version is not 1",
    family: "§6.1 rule 2",
    mutations: { tstInfoVersion: 2 },
  },
  {
    name: "a critical TSTInfo extension this profile does not know",
    family: "§6.1 rule 2",
    mutations: { unknownCriticalExtension: true },
  },
  {
    name: "two SignerInfos",
    family: "§6.1 rule 3",
    mutations: { twoSignerInfos: true },
  },
  {
    name: "signedAttrs absent",
    family: "§6.1 rule 4",
    mutations: { omitSignedAttrs: true },
  },
  {
    name: "the contentType attribute names id-data",
    family: "§6.1 rule 4",
    mutations: { wrongContentTypeAttribute: true },
  },
  {
    name: "the messageDigest attribute is not the digest of eContent",
    family: "§6.1 rule 4",
    mutations: { wrongMessageDigestAttribute: true },
  },
  {
    name: "eContent tampered against a valid messageDigest attribute",
    family: "§11 family 2",
    mutations: { tamperedEContent: true },
  },
  {
    name: "SHA-1 message imprint",
    family: "§11 family 7",
    mutations: { sha1Imprint: true },
  },
  {
    name: "SHA-1 SignerInfo digest algorithm",
    family: "§11 family 7",
    mutations: { sha1SignerInfoDigest: true },
  },
  {
    name: "a signature algorithm whose digest component is SHA-1",
    family: "§11 family 7",
    mutations: { sha1SignatureAlgorithm: true },
  },
  {
    name: "the v1 SigningCertificate attribute (ESSCertID is SHA-1)",
    family: "§11 family 7",
    mutations: { signingCertificateV1: true },
  },
  {
    name: "SigningCertificateV2 names a certificate not embedded",
    family: "§6.1 rule 6",
    mutations: { signingCertificateV2NamesAbsentCertificate: true },
  },
  {
    name: "no embedded signer certificate",
    family: "§6.1 rule 6",
    mutations: { omitEmbeddedCertificate: true },
  },
  {
    name: "sid inconsistent with the identified certificate",
    family: "§6.1 rule 7",
    mutations: { inconsistentSid: true },
  },
  {
    name: "the signature covers eContent instead of the signedAttrs SET OF",
    family: "§6.1 rule 8",
    mutations: { signOverEContent: true },
  },
  {
    name: "a structurally sound signature made by a different key",
    family: "§11 family 2",
    mutations: { brokenSignature: true },
  },
  {
    name: "extended key usage carries an additional usage",
    family: "§6.1 rule 9",
    mutations: { additionalExtendedKeyUsage: true },
  },
  {
    name: "no extended key usage extension",
    family: "§6.1 rule 9",
    mutations: { omitExtendedKeyUsage: true },
  },
  {
    name: "the tsa field names a subject the signer certificate does not present",
    family: "§6.1 rule 10",
    mutations: { tsaNameMismatch: true },
  },
  {
    name: "genTime outside the signer certificate's validity window",
    family: "§6.1 rule 11",
    mutations: { genTimeOutsideValidity: true },
  },
  {
    name: "genTime with trailing fractional zeros",
    family: "§6.1 rule 11",
    mutations: { malformedGenTime: "trailing-fraction-zeros" },
  },
  {
    name: "genTime without the Zulu designator",
    family: "§6.1 rule 11",
    mutations: { malformedGenTime: "missing-zulu" },
  },
  {
    name: "genTime without seconds",
    family: "§6.1 rule 11",
    mutations: { malformedGenTime: "missing-seconds" },
  },
  {
    name: "messageImprint.hashedMessage is not the subject digest",
    family: "§6.1 rule 12",
    mutations: { imprintMismatch: true },
  },
  {
    name: "indefinite-length outer encoding",
    family: "§6.1 parsing discipline",
    mutations: { indefiniteLengthOuter: true },
  },
];

const BOTH_TRUST_MATERIALS = ["none", "kit"] as const;

function rfc3161Cases(
  kit: AnchorKitFixtures,
  options: AnchorProofContractCaseOptions,
): readonly AnchorProofContractCase[] {
  const valid = kit.authority.mintTimeStampToken({ subjectSha256: kit.subjectSha256 });
  const cases: AnchorProofContractCase[] = [
    // Family 1, and the flip that proves trust material is really caller-side:
    // the same bytes, the same subject, two outcomes decided only by what the
    // verifier's operator supplied.
    {
      name: "a valid token is present when no trust material is supplied",
      family: "§11 family 1",
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      proofBytes: valid.tokenDer,
      subjectSha256: kit.subjectSha256,
      trustMaterial: "none",
      expected: {
        status: "present",
        timeBasis: "authority-time",
        facts: { ...valid.facts },
      },
    },
    {
      name: "the same valid token is verified against the kit authority root",
      family: "§11 family 1",
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      proofBytes: valid.tokenDer,
      subjectSha256: kit.subjectSha256,
      trustMaterial: "kit",
      expected: {
        status: "verified",
        timeBasis: "authority-time",
        time: valid.facts.genTime,
        facts: { ...valid.facts },
      },
    },
    // Rule 12 from the caller's side: the token is untouched and the subject is
    // not the one it covers.
    ...BOTH_TRUST_MATERIALS.map((trustMaterial): AnchorProofContractCase => ({
      name: `a valid token over another subject digest is invalid (trust material: ${trustMaterial})`,
      family: "§6.1 rule 12",
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      proofBytes: valid.tokenDer,
      subjectSha256: KIT_UNRELATED_SUBJECT_SHA256,
      trustMaterial,
      expected: { status: "invalid" },
    })),
    ...BOTH_TRUST_MATERIALS.map((trustMaterial): AnchorProofContractCase => ({
      name: `empty proof bytes are invalid (trust material: ${trustMaterial})`,
      family: "§6.1 parsing discipline",
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      proofBytes: new Uint8Array(0),
      subjectSha256: kit.subjectSha256,
      trustMaterial,
      expected: { status: "invalid" },
    })),
    ...BOTH_TRUST_MATERIALS.map((trustMaterial): AnchorProofContractCase => ({
      name: `a truncated token is invalid (trust material: ${trustMaterial})`,
      family: "§6.1 parsing discipline",
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      proofBytes: valid.tokenDer.subarray(0, Math.floor(valid.tokenDer.length / 2)),
      subjectSha256: kit.subjectSha256,
      trustMaterial,
      expected: { status: "invalid" },
    })),
  ];

  // Every named negative, run with and without trust material: a refusal must
  // never depend on the verifier operator's configuration.
  for (const negative of RFC3161_NEGATIVES) {
    const minted = kit.authority.mintTimeStampToken({
      subjectSha256: kit.subjectSha256,
      ...negative.mutations,
    });
    for (const trustMaterial of BOTH_TRUST_MATERIALS) {
      cases.push({
        name: `${negative.name} is invalid (trust material: ${trustMaterial})`,
        family: negative.family,
        profile: RFC3161_TSA_ANCHOR_PROFILE,
        proofBytes: minted.tokenDer,
        subjectSha256: kit.subjectSha256,
        trustMaterial,
        expected: { status: "invalid" },
      });
    }
  }

  for (const realToken of options.realTokens ?? []) {
    cases.push({
      name: `the captured ${realToken.name} token is present without its authority's root`,
      family: "§11 captured real tokens",
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      proofBytes: realToken.tokenDer,
      subjectSha256: realToken.subjectSha256,
      trustMaterial: "none",
      expected: {
        status: "present",
        timeBasis: "authority-time",
        facts: { ...realToken.facts },
      },
    });
    cases.push({
      name: `the captured ${realToken.name} token over another subject digest is invalid`,
      family: "§6.1 rule 12",
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      proofBytes: realToken.tokenDer,
      subjectSha256: KIT_UNRELATED_SUBJECT_SHA256,
      trustMaterial: "none",
      expected: { status: "invalid" },
    });
  }

  return cases;
}

function openTimestampsCases(kit: AnchorKitFixtures): readonly AnchorProofContractCase[] {
  const ots = kit.openTimestamps;
  const height = { blockHeight: ots.blockHeight };
  return [
    {
      name: "a complete proof is present when no block headers are supplied",
      family: "§11 family 1",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      proofBytes: ots.completeProof,
      subjectSha256: kit.subjectSha256,
      trustMaterial: "none",
      expected: { status: "present", timeBasis: "chain-time", facts: height },
    },
    {
      name: "the same complete proof is verified against the kit block header",
      family: "§11 family 1",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      proofBytes: ots.completeProof,
      subjectSha256: kit.subjectSha256,
      trustMaterial: "kit",
      expected: {
        status: "verified",
        timeBasis: "chain-time",
        time: KIT_BITCOIN_BLOCK_TIME,
        facts: height,
      },
    },
    ...BOTH_TRUST_MATERIALS.map((trustMaterial): AnchorProofContractCase => ({
      name: `a calendar-only proof is pending (trust material: ${trustMaterial})`,
      family: "§11 family 6",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      proofBytes: ots.pendingProof,
      subjectSha256: kit.subjectSha256,
      trustMaterial,
      // A pending proof is not checkable even in principle, so supplying
      // headers changes nothing -- and a verifier must never reach for the
      // network to upgrade it (§4.3).
      expected: { status: "pending", timeBasis: "authority-time" },
    })),
    {
      name: "a fabricated complete proof is present when no block headers are supplied",
      family: "§11 family 10",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      proofBytes: ots.fabricatedCompleteProof,
      subjectSha256: kit.subjectSha256,
      trustMaterial: "none",
      // Structural replay self-consistency is not chain evaluation: the
      // attributive sealed copy stands, and nothing assertive prints.
      expected: { status: "present", timeBasis: "chain-time", facts: height },
    },
    {
      name: "the same fabricated proof is invalid against the kit block header",
      family: "§11 family 10",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      proofBytes: ots.fabricatedCompleteProof,
      subjectSha256: kit.subjectSha256,
      trustMaterial: "kit",
      expected: { status: "invalid" },
    },
    ...BOTH_TRUST_MATERIALS.map((trustMaterial): AnchorProofContractCase => ({
      name: `a complete proof over another subject digest is invalid (trust material: ${trustMaterial})`,
      family: "§6.2 digest binding",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      proofBytes: ots.completeProof,
      subjectSha256: KIT_UNRELATED_SUBJECT_SHA256,
      trustMaterial,
      expected: { status: "invalid" },
    })),
    ...BOTH_TRUST_MATERIALS.map((trustMaterial): AnchorProofContractCase => ({
      name: `empty proof bytes are invalid (trust material: ${trustMaterial})`,
      family: "§6.2 structure",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      proofBytes: new Uint8Array(0),
      subjectSha256: kit.subjectSha256,
      trustMaterial,
      expected: { status: "invalid" },
    })),
    ...BOTH_TRUST_MATERIALS.map((trustMaterial): AnchorProofContractCase => ({
      name: `a truncated proof is invalid (trust material: ${trustMaterial})`,
      family: "§6.2 structure",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      proofBytes: ots.completeProof.subarray(0, ots.completeProof.length - 3),
      subjectSha256: kit.subjectSha256,
      trustMaterial,
      expected: { status: "invalid" },
    })),
  ];
}

/**
 * Every case for both v1 provider profiles. Callers filter by `profile`;
 * `describeAnchorProofVerifierContract` does exactly that.
 */
export function anchorProofContractCases(
  kit: AnchorKitFixtures,
  options: AnchorProofContractCaseOptions = {},
): readonly AnchorProofContractCase[] {
  return [...rfc3161Cases(kit, options), ...openTimestampsCases(kit)];
}

// ---------------------------------------------------------------------------
// The pure runner
// ---------------------------------------------------------------------------

export interface AnchorProofCaseFailure {
  readonly case: string;
  readonly reason: string;
}

/** Builds the implementation's own trust material from the kit fixtures. The
 * kit never guesses a verifier's `TTrust` shape; the adapter is the seam. */
export type AnchorKitTrustAdapter<TTrust> = (kit: AnchorKitFixtures) => TTrust;

function describeResult(result: AnchorProofResult): string {
  return result.status === "invalid" || result.status === "pending"
    ? `${result.status} (${result.reason})`
    : result.status;
}

function factsOf(result: AnchorProofResult): Record<string, unknown> | undefined {
  return result.status === "verified" || result.status === "present"
    ? (result.facts as Record<string, unknown>)
    : undefined;
}

/** Runs one case, returning a failure or `undefined`. Pure: no vitest, no I/O. */
export function runAnchorProofContractCase<TTrust>(
  verifier: AnchorProofVerifier<unknown, TTrust>,
  trust: TTrust,
  testCase: AnchorProofContractCase,
): AnchorProofCaseFailure | undefined {
  const fail = (reason: string): AnchorProofCaseFailure => ({ case: testCase.name, reason });

  if (verifier.profile !== testCase.profile) {
    return fail(`verifier declares profile ${verifier.profile}, case is for ${testCase.profile}`);
  }

  let result: AnchorProofResult;
  try {
    result = verifier.verifyProof({
      subjectSha256: testCase.subjectSha256,
      proofBytes: testCase.proofBytes,
      ...(testCase.trustMaterial === "kit" ? { trust } : {}),
    });
  } catch (cause) {
    // A rule failure is a reported `invalid`, never a thrown error: the check
    // that consumes this must be able to report every anchor it carries.
    return fail(`verifyProof threw: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const { expected } = testCase;
  if (result.status !== expected.status) {
    return fail(`expected ${expected.status}, got ${describeResult(result)}`);
  }
  if (result.profile !== testCase.profile) {
    return fail(`result declares profile ${result.profile}, expected ${testCase.profile}`);
  }
  if (expected.timeBasis !== undefined) {
    const timeBasis = result.status === "invalid" ? undefined : result.timeBasis;
    if (timeBasis !== expected.timeBasis) {
      return fail(`expected time basis ${expected.timeBasis}, got ${String(timeBasis)}`);
    }
  }
  if (expected.time !== undefined) {
    const time = result.status === "verified" ? result.time : undefined;
    if (time !== expected.time) {
      return fail(`expected evaluated time ${expected.time}, got ${String(time)}`);
    }
  }
  // §4.3: only `verified` reports an evaluated instant. A `present` result that
  // carried one would be claiming an evaluation it did not perform.
  if (expected.status === "present" && "time" in result) {
    return fail("a present result must not report an evaluated time");
  }
  if (expected.facts !== undefined) {
    const facts = factsOf(result);
    if (facts === undefined) return fail(`expected extracted facts, got ${describeResult(result)}`);
    for (const [key, value] of Object.entries(expected.facts)) {
      if (!Object.hasOwn(facts, key)) return fail(`extracted facts are missing "${key}"`);
      if (facts[key] !== value) {
        return fail(`expected fact "${key}" to be ${String(value)}, got ${String(facts[key])}`);
      }
    }
  }
  return undefined;
}

export function runAnchorProofContractCases<TTrust>(
  verifier: AnchorProofVerifier<unknown, TTrust>,
  trust: TTrust,
  cases: readonly AnchorProofContractCase[],
): readonly AnchorProofCaseFailure[] {
  return cases.flatMap((testCase) => {
    const failure = runAnchorProofContractCase(verifier, trust, testCase);
    return failure === undefined ? [] : [failure];
  });
}

// ---------------------------------------------------------------------------
// The vitest suite
// ---------------------------------------------------------------------------

export interface AnchorProofVerifierContractContext<TTrust = unknown> {
  readonly verifier: AnchorProofVerifier<unknown, TTrust>;
  /** The implementation's own trust material, built from the kit fixtures. It is
   * supplied only to the cases that ask for it -- which is how the kit proves
   * trust material is caller-side and never bundle-side. */
  readonly trust: TTrust;
  cleanup?: () => Promise<void> | void;
}

export type AnchorProofVerifierContractFactory<TTrust = unknown> = (
  kit: AnchorKitFixtures,
) => Promise<AnchorProofVerifierContractContext<TTrust>> | AnchorProofVerifierContractContext<TTrust>;

/**
 * The suite an `AnchorProofVerifier` implementation runs against.
 *
 * `profile` is declared by the caller rather than read from the verifier so the
 * case set is decided at collection time; the suite still asserts the verifier
 * agrees, so a mis-declared implementation fails loudly rather than silently
 * running someone else's cases.
 */
export function describeAnchorProofVerifierContract<TTrust>(
  profile: string,
  createContext: AnchorProofVerifierContractFactory<TTrust>,
  options: AnchorProofContractCaseOptions = {},
): void {
  const kit = createAnchorKitFixtures();
  const cases = anchorProofContractCases(kit, options).filter(
    (testCase) => testCase.profile === profile,
  );

  describe(`Anchor proof verifier contract (${profile})`, () => {
    let context: AnchorProofVerifierContractContext<TTrust>;

    beforeEach(async () => {
      context = await createContext(kit);
    });

    afterEach(async () => {
      await context.cleanup?.();
    });

    test("the suite has cases for this profile", () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    test("the verifier declares the profile the suite was asked for", () => {
      expect(context.verifier.profile).toBe(profile);
    });

    for (const testCase of cases) {
      test(`[${testCase.family}] ${testCase.name}`, () => {
        const failure = runAnchorProofContractCase(context.verifier, context.trust, testCase);
        expect(failure?.reason).toBeUndefined();
      });
    }
  });
}
