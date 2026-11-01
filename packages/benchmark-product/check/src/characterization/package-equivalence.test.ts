// SPDX-License-Identifier: Apache-2.0

/**
 * The checker's own general record code, run beside `@jinn-network/verify` on the same inputs
 * (issue #5120). This is what lets the runtime switch delete the local copies: for every signature
 * site, did:key derivation and decoding, and the anchor evaluator, the two give the same outcome
 * over the whole characterization corpus and over seeded random inputs, or the difference is named
 * in `testing/known-differences.ts` with what the switch does about it.
 *
 * "Local" here is the production code, not a copy of it, including the three signature checks
 * private to `verify.ts`: `testing/site-tap.ts` stands at the seams they cross. "Package" is
 * `testing/package-sites.ts`, written as the switch will write it.
 *
 * The corpus is the characterization suite's own 131 cases. `checker-outputs.test.ts` pins what the
 * checker says; this suite pins that the package would have said the same at every step on the way.
 *
 * To try another seed: CHECKER_EQUIVALENCE_SEED=7 yarn vitest run src/characterization/package-equivalence.test.ts
 */

import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
  type KeyPairKeyObjectResult,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRun } from "@jinn-network/benchmarking-records";
import { dssePreAuthEncoding, parseDsseEnvelope, parseExactDsseEnvelope } from "@jinn-network/trust-core";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { evaluateIntegrityAnchors } from "../anchor/check.js";
import {
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
  keyFingerprintFromDidKey,
} from "../identity/did-key.js";
import { buildAssemblyPortsFromFacts, type AssemblyPublicKeyRecord } from "../profile/assembly-ports.js";
import { didKeyFromEd25519PublicKey, verifyReportEnvelopeSignatures } from "../profile/signing.js";
import { GOLDEN_BUNDLE_DIR } from "../testing/golden-asset-input.js";
import { verifyPublicBundle } from "../verify.js";
import { ANCHOR_CASES } from "./testing/anchor-cases.js";
import { REVIEWERS, REVIEWER_IDS } from "./testing/binary-admission-bundles.js";
import { BUNDLE_CASES } from "./testing/bundle-cases.js";
import { EVIDENCE_NATIVE_EVALUATOR } from "./testing/evidence-native-bundles.js";
import { KNOWN_DIFFERENCES } from "./testing/known-differences.js";
import { observeBundle } from "./testing/observe.js";
import {
  randomAnchorInput,
  randomDetachedSignature,
  randomDidKey,
  randomEnvelope,
  randomSpki,
  seededRng,
  type EnvelopeSigner,
  type Rng,
} from "./testing/random-inputs.js";
import { SIGNATURE_CASES } from "./testing/signature-cases.js";
import { kitReportSigner, signerFromLabel, type PinnedSigner } from "./testing/signers.js";
import {
  SITES,
  capturedAdmission,
  capturedEvidenceNativeCheck,
  compareAuthority,
  compareEvidenceNative,
  compareReviewer,
  enterBundle,
  seeBundle,
  seenSoFar,
  takeDifferences,
  takeTallies,
  type CapturedAdmission,
  type Difference,
  type HeldKey,
  type SiteId,
} from "./testing/site-tap.js";

// MOCK_JUSTIFICATION: a pass-through, not a fake. The real code runs and its answer is returned; the wrapper only runs the package beside it. Three sites are closures with no export, and #5120 changes no production file before the runtime switch.
vi.mock("../profile/signing.js", async (importOriginal) => (await import("./testing/site-tap.js")).tapSigning(await importOriginal()));
// MOCK_JUSTIFICATION: the same pass-through, for resolveEvaluatorClaim, which is private to this module.
vi.mock("../profile/assembly-ports.js", async (importOriginal) => (await import("./testing/site-tap.js")).tapAssemblyPorts(await importOriginal()));
// MOCK_JUSTIFICATION: the same pass-through, for the did:key decoders.
vi.mock("../identity/did-key.js", async (importOriginal) => (await import("./testing/site-tap.js")).tapDidKey(await importOriginal()));
// MOCK_JUSTIFICATION: the same pass-through, for the anchor evaluator.
vi.mock("../anchor/check.js", async (importOriginal) => (await import("./testing/site-tap.js")).tapAnchorCheck(await importOriginal()));
// MOCK_JUSTIFICATION: the same pass-through. This is the seam the two admission signature closures in verify.ts cross.
vi.mock("../admission/verification.js", async (importOriginal) => (await import("./testing/site-tap.js")).tapAdmission(await importOriginal()));
// MOCK_JUSTIFICATION: the same pass-through. This is the seam the evidence-native signature closure in verify.ts crosses.
vi.mock("@jinn-network/benchmarking-evidence", async (importOriginal) => (await import("./testing/site-tap.js")).tapEvidence(await importOriginal()));

const EXPECTED_PATH = fileURLToPath(new URL("./testing/checker-outputs.expected.json", import.meta.url));
const KIT_DIR = fileURLToPath(new URL("../../fixtures/public-bundle-conformance-v1/", import.meta.url));
const kit = JSON.parse(readFileSync(join(KIT_DIR, "manifest.json"), "utf8")) as {
  readonly golden: { readonly path: string };
  readonly fixtures: readonly { readonly path: string }[];
};

const SEED = Number(process.env["CHECKER_EQUIVALENCE_SEED"] ?? 5120);
const ROUNDS = 2_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const KIT_BUNDLES: readonly (readonly [string, () => string])[] = [kit.golden, ...kit.fixtures]
  .map(({ path }) => [`kit/${path}`, () => join(KIT_DIR, path)]);
const BUNDLES = [...KIT_BUNDLES, ...Object.entries(BUNDLE_CASES)];

/** A bundle goes through every surface a reader has, as the characterization suite runs it. */
async function runBundle(bundleDir: string): Promise<void> {
  seeBundle(bundleDir);
  enterBundle(bundleDir);
  await observeBundle(bundleDir);
  enterBundle(undefined);
}

const CORPUS: readonly (readonly [string, () => unknown])[] = [
  ...BUNDLES.map(([id, bundleDir]) => [id, () => runBundle(bundleDir())] as const),
  ...Object.entries(SIGNATURE_CASES),
  ...Object.entries(ANCHOR_CASES).map(([id, observe]) => [`anchors/${id}`, observe] as const),
];

const DSSE_SITES: readonly SiteId[] = [
  SITES.evidenceNative,
  SITES.reviewer,
  SITES.authority,
  SITES.reportEnvelope,
  SITES.evaluatorClaim,
];

function expectEverySiteGaveBothAnswers(sites: readonly SiteId[]): void {
  const tallies = takeTallies();
  for (const site of sites) {
    expect(tallies.get(site)?.accepted ?? 0, `${site} never said yes`).toBeGreaterThan(0);
    expect(tallies.get(site)?.refused ?? 0, `${site} never said no`).toBeGreaterThan(0);
  }
}

function expectNoDifference(): void {
  expect(takeDifferences()).toEqual([]);
}

function pinnedDifferences(id: string): readonly Difference[] {
  return KNOWN_DIFFERENCES.flatMap(({ site, cases }) => {
    const pinned = cases[id];
    return pinned === undefined ? [] : [{ site, ...pinned }];
  });
}

describe("the characterization corpus, case by case", () => {
  test("is the characterization suite's own", () => {
    const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as Record<string, unknown>;
    expect(CORPUS.map(([id]) => id)).toEqual(Object.keys(expected));
    expect(CORPUS).toHaveLength(131);
  });

  for (const [id, observe] of CORPUS) {
    test(id, async () => {
      await observe();
      expect(takeDifferences()).toStrictEqual(pinnedDifferences(id));
    });
  }

  test("reached every site, and every site said both yes and no", () => {
    expectEverySiteGaveBothAnswers([
      ...DSSE_SITES,
      SITES.didKeyDerivation,
      SITES.didKeyDerivationKept,
      SITES.didKeyBytes,
      SITES.didKeyObject,
      SITES.didKeyFingerprint,
      SITES.anchors,
    ]);
  });
});

describe("the pinned list of differences", () => {
  test("each names corpus cases, why they differ, and what the runtime switch does", () => {
    const corpusIds = CORPUS.map(([id]) => id);
    for (const { cases, why, planForRuntimeSwitch } of KNOWN_DIFFERENCES) {
      expect(Object.keys(cases).length).toBeGreaterThan(0);
      expect(corpusIds).toEqual(expect.arrayContaining(Object.keys(cases)));
      expect(why).not.toBe("");
      expect(planForRuntimeSwitch).not.toBe("");
    }
  });
});

test("the RFC 3161 ports are the same source, byte for byte", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  expect(source("../anchor/ports.ts")).toBe(source("../../../../discovery/verification/src/anchor/ports.ts"));
});

/** Key types past Ed25519. Two sites take any key, so they must answer alike on all of them. */
const FOREIGN_KEYS: readonly (readonly [string, KeyPairKeyObjectResult])[] = [
  ["P-256", generateKeyPairSync("ec", { namedCurve: "P-256" })],
  ["secp256k1", generateKeyPairSync("ec", { namedCurve: "secp256k1" })],
  ["P-384", generateKeyPairSync("ec", { namedCurve: "P-384" })],
  ["P-521", generateKeyPairSync("ec", { namedCurve: "P-521" })],
  ["RSA", generateKeyPairSync("rsa", { modulusLength: 1024 })],
  ["RSA-PSS", generateKeyPairSync("rsa-pss", { modulusLength: 1024 })],
  ["DSA", generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: 160 })],
  ["Ed448", generateKeyPairSync("ed448")],
  ["X25519", generateKeyPairSync("x25519")],
  ["X448", generateKeyPairSync("x448")],
];

interface KeyInPlay extends HeldKey {
  readonly signer: EnvelopeSigner;
}

function signerFor(keyId: string, privateKey: KeyObject): EnvelopeSigner {
  return {
    keyId,
    sign: (message) => {
      try {
        return new Uint8Array(sign(null, message, privateKey));
      } catch {
        // X25519 and X448 cannot sign, so a key of those types only ever meets a wrong signature.
        return new Uint8Array(64);
      }
    },
  };
}

function inPlay({ keyId, publicKey, privateKey }: PinnedSigner): KeyInPlay {
  return { keyId, publicKey, signer: signerFor(keyId, privateKey) };
}

/** Half the rounds under the site's real key type, and the rest spread over all of them. */
function keysOfEveryType(rng: Rng, primary: PinnedSigner): () => KeyInPlay {
  const own = inPlay(primary);
  const others = FOREIGN_KEYS.map(([name, { publicKey, privateKey }]): KeyInPlay => ({
    keyId: `urn:key:${name}`,
    publicKey,
    signer: signerFor(`urn:key:${name}`, privateKey),
  }));
  return () => (rng.chance(0.5) ? own : rng.pick([own, ...others]));
}

const strangerKey = signerFromLabel("equivalence-stranger");
const stranger = signerFor(strangerKey.keyId, strangerKey.privateKey);
const reportSigner = kitReportSigner();
const reviewer = REVIEWERS[0]!;

const EVALUATOR = "urn:evaluator:equivalence";
const goldenRun = parseRun(new Uint8Array(readFileSync(join(GOLDEN_BUNDLE_DIR, "run.json"))));

/** The real `resolveEvaluatorClaim`, reached the only way it can be. */
function resolveClaim(envelope: Uint8Array, key: AssemblyPublicKeyRecord): Promise<string> {
  return buildAssemblyPortsFromFacts({
    runRecord: goldenRun,
    cells: [],
    owner: "urn:owner:equivalence",
    runCancelled: false,
    receiptsByTaskDigest: new Map(),
    resolveBytes: () => envelope,
    evaluatorKeys: () => new Map([[EVALUATOR, key]]),
  }).trust.resolveAgent({ role: "evaluator", claim: EVALUATOR, verdictDigest: "sha256:00" }, new Date(0));
}

function spkiOf(key: KeyObject): Uint8Array {
  return new Uint8Array(key.export({ format: "der", type: "spki" }));
}

function isExactEnvelope(envelope: Uint8Array): boolean {
  try {
    parseExactDsseEnvelope(envelope);
    return true;
  } catch {
    return false;
  }
}

/** The private closures come from running one bundle that reaches them, so no test order is assumed. */
async function captureClosures(): Promise<CapturedAdmission> {
  const reach = async (id: string): Promise<void> => {
    const bundleDir = BUNDLE_CASES[id]!();
    enterBundle(bundleDir);
    await verifyPublicBundle(bundleDir).catch(() => undefined);
    enterBundle(undefined);
  };
  await reach("evidence-native-signature/valid-signature");
  await reach("admission-reviewer-signature/valid-signature");
  const captured = capturedAdmission();
  if (captured === undefined || capturedEvidenceNativeCheck() === undefined) {
    throw new Error("the corpus bundles no longer reach the private signature closures");
  }
  return captured;
}

function evidenceNativeInput(input: {
  readonly publicKeyBytes: Uint8Array;
  readonly preAuthEncoding: Uint8Array;
  readonly signature: Uint8Array;
}) {
  return {
    ...input,
    payloadType: "application/octet-stream",
    payloadBytes: new Uint8Array(),
    signatureIndex: 0,
    identity: EVALUATOR,
    purpose: "automated-evaluator" as const,
  };
}

function signaturesOf(envelope: Uint8Array): readonly { readonly preAuthEncoding: Uint8Array; readonly signature: Uint8Array }[] {
  try {
    const { payloadType, payloadBytes, signatures } = parseDsseEnvelope(envelope);
    const preAuthEncoding = dssePreAuthEncoding(payloadType, payloadBytes);
    return signatures.map(({ sig }) => ({ preAuthEncoding, signature: new Uint8Array(Buffer.from(sig, "base64")) }));
  } catch {
    return [];
  }
}

function decodeEverywhere(keyId: string): void {
  ed25519PublicKeyBytesFromDidKey(keyId);
  ed25519PublicKeyFromDidKey(keyId);
  keyFingerprintFromDidKey(keyId);
}

/** Starts a section from the same place whichever tests ran before it. */
function clearTheLedger(): void {
  takeDifferences();
  takeTallies();
}

describe("everything the corpus carries, through every site", () => {
  let captured: CapturedAdmission;

  beforeAll(async () => {
    if (seenSoFar().envelopes.size === 0) for (const [, observe] of CORPUS) await observe();
    captured = await captureClosures();
    clearTheLedger();
  });

  test("every DSSE envelope at all five signature sites, under every key where the site takes one", async () => {
    const { envelopes, keys } = seenSoFar();
    const { role, keyId } = captured.keys.trust.admission.authorities[0]!;
    for (const envelope of envelopes.values()) {
      const signatures = signaturesOf(envelope);
      for (const key of keys.values()) {
        verifyReportEnvelopeSignatures(envelope, key);
        await resolveClaim(envelope, key);
        for (const { preAuthEncoding, signature } of signatures) {
          await compareEvidenceNative(evidenceNativeInput({ publicKeyBytes: spkiOf(key.publicKey), preAuthEncoding, signature }));
        }
      }
      compareReviewer(captured, { envelopeBytes: envelope, evaluatorId: REVIEWER_IDS[0]!, keyId: reviewer.keyId });
      compareAuthority(captured, { envelopeBytes: envelope, keyId, role });
    }
    expectNoDifference();
    expectEverySiteGaveBothAnswers(DSSE_SITES);
  });

  test("every did:key, and the did:key of every Ed25519 key, through derivation and all three decoders", () => {
    const { didKeys, keys } = seenSoFar();
    for (const { publicKey } of keys.values()) {
      if (publicKey.asymmetricKeyType === "ed25519") didKeys.add(didKeyFromEd25519PublicKey(publicKey));
    }
    for (const keyId of didKeys) decodeEverywhere(keyId);
    expectNoDifference();
    expectEverySiteGaveBothAnswers([SITES.didKeyBytes, SITES.didKeyObject, SITES.didKeyFingerprint]);
  });
});

describe(`seeded random inputs, seed ${SEED}`, () => {
  let captured: CapturedAdmission;
  let rng: Rng;

  beforeAll(async () => {
    captured = await captureClosures();
    rng = seededRng(SEED);
    clearTheLedger();
  });

  test("the Report envelope site, under keys of every type", () => {
    const nextKey = keysOfEveryType(rng, reportSigner);
    let respelledAndAccepted = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const key = nextKey();
      const envelope = randomEnvelope(rng, key.signer, stranger);
      const { validSignerKeyids } = verifyReportEnvelopeSignatures(envelope, key);
      if (validSignerKeyids.length > 0 && !isExactEnvelope(envelope)) respelledAndAccepted += 1;
    }
    expectNoDifference();
    expectEverySiteGaveBothAnswers([SITES.reportEnvelope]);
    expect(respelledAndAccepted).toBeGreaterThan(0);
  });

  test("the evaluator claim site, under keys of every type", async () => {
    const nextKey = keysOfEveryType(rng, signerFromLabel("equivalence-evaluator"));
    let respelledAndAccepted = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const key = nextKey();
      const envelope = randomEnvelope(rng, key.signer, stranger);
      const resolved = await resolveClaim(envelope, key);
      if (resolved !== "unresolved" && !isExactEnvelope(envelope)) respelledAndAccepted += 1;
    }
    expectNoDifference();
    expectEverySiteGaveBothAnswers([SITES.evaluatorClaim]);
    expect(respelledAndAccepted).toBeGreaterThan(0);
  });

  test("the reviewer site, through the real closure", () => {
    const { signer } = inPlay(reviewer);
    for (let round = 0; round < ROUNDS; round += 1) {
      compareReviewer(captured, {
        envelopeBytes: randomEnvelope(rng, signer, stranger),
        evaluatorId: rng.chance(0.9) ? REVIEWER_IDS[0]! : "urn:reviewer:absent",
        keyId: rng.chance(0.9) ? reviewer.keyId : strangerKey.keyId,
      });
    }
    expectNoDifference();
    expectEverySiteGaveBothAnswers([SITES.reviewer]);
  });

  test("the authority site, through the real closure", () => {
    const { signer } = inPlay(reportSigner);
    const { role, keyId } = captured.keys.trust.admission.authorities[0]!;
    for (let round = 0; round < ROUNDS; round += 1) {
      compareAuthority(captured, {
        envelopeBytes: randomEnvelope(rng, signer, stranger),
        // This bundle binds no key to the third role.
        role: rng.chance(0.9) ? role : "operator-truth-attestor",
        keyId: rng.chance(0.9) ? keyId : strangerKey.keyId,
      });
    }
    expectNoDifference();
    expectEverySiteGaveBothAnswers([SITES.authority]);
  });

  test("the evidence-native site, through the real closure, under keys of every type", async () => {
    const nextKey = keysOfEveryType(rng, EVIDENCE_NATIVE_EVALUATOR);
    for (let round = 0; round < ROUNDS; round += 1) {
      const { publicKey, signer } = nextKey();
      await compareEvidenceNative(evidenceNativeInput({
        publicKeyBytes: randomSpki(rng, spkiOf(publicKey)),
        ...randomDetachedSignature(rng, rng.chance(0.9) ? signer : stranger),
      }));
    }
    expectNoDifference();
    expectEverySiteGaveBothAnswers([SITES.evidenceNative]);
  });

  test("did:key decoding", () => {
    for (let round = 0; round < ROUNDS * 5; round += 1) decodeEverywhere(randomDidKey(rng));
    expectNoDifference();
    expectEverySiteGaveBothAnswers([SITES.didKeyBytes, SITES.didKeyObject, SITES.didKeyFingerprint]);
  });

  test("did:key derivation, over Ed25519 keys", () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      didKeyFromEd25519PublicKey(createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, rng.bytes(32)]),
        format: "der",
        type: "spki",
      }));
    }
    expectNoDifference();
  });

  test("did:key derivation, over every other key type, differs only as the known difference says", () => {
    for (const [name, { publicKey }] of FOREIGN_KEYS) {
      // The tap records a throw. A throw here is the local code's own answer for this key type.
      try {
        didKeyFromEd25519PublicKey(publicKey);
      } catch {}
      const differences = takeDifferences();
      expect(differences.map(({ site }) => site), name).toEqual([SITES.didKeyDerivation]);
      expect(differences[0]?.package, name).toMatchObject({
        threw: { message: expect.stringMatching(/^did:key derivation needs an Ed25519 public key, got /u) },
      });
    }
  });

  test("the anchor evaluator", () => {
    for (const observe of Object.values(ANCHOR_CASES)) observe();
    const inputs = [...seenSoFar().anchorInputs];
    clearTheLedger();
    for (let round = 0; round < ROUNDS; round += 1) evaluateIntegrityAnchors(randomAnchorInput(rng, inputs));
    expectNoDifference();
    expectEverySiteGaveBothAnswers([SITES.anchors]);
  });
});
