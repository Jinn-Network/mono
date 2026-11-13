// SPDX-License-Identifier: Apache-2.0

/**
 * The signature and trust refusals the conformance kit does not reach, each as a bundle the checker
 * is run on end to end. Every case that names a signature site says which one, because the sites
 * are what the record-verification move rewrites.
 *
 * A `valid-signature` case is the other half of its refusals. It ends at a later refusal, and that
 * refusal is the evidence the signature was accepted: a check that refused everything would pass
 * every refusal case alone.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { buildRfc3161AnchorEvidenceRecord, createFixtureAuthority } from "@jinn-network/trust-testing";
import { verdictKeyIdFromEd25519PublicKey } from "../../profile/verdict.js";
import { GOLDEN_BUNDLE_DIR } from "../../testing/golden-asset-input.js";
import { operatorOnlyBundle, twoHumanBundle } from "./binary-admission-bundles.js";
import { EVIDENCE_NATIVE_EVALUATOR, evidenceNativeBundle } from "./evidence-native-bundles.js";
import { goldenAnchoredBy, goldenWith, goldenWithReportSignatures } from "./golden-variants.js";
import {
  FOREIGN_SPKI_BASE64,
  allOf,
  flipped,
  kitReportSigner,
  p256SignerUnderKeyId,
  signedBy,
  signerFromLabel,
} from "./signers.js";

const stranger = signerFromLabel("stranger");
const reportKey = kitReportSigner();
const notAKey = Buffer.from("not a key").toString("base64");
const TRUST = "trust/public-keys.json";
const anchorAuthority = createFixtureAuthority("checker-characterization");
const GOLDEN_RUN_SHA256 = createHash("sha256").update(readFileSync(join(GOLDEN_BUNDLE_DIR, "run.json"))).digest("hex");

function urlSafe(base64: string): string {
  const spelled = base64.replaceAll("+", "-").replaceAll("/", "_");
  // A value with neither character reads the same in both alphabets and would prove nothing.
  if (spelled === base64) throw new Error("value has no URL-unsafe character");
  return spelled;
}

function carriedAnchorOver(subjectSha256: string, genTime = "20260101000000Z") {
  const built = buildRfc3161AnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256,
    proofBytes: anchorAuthority.mintTimeStampToken({ subjectSha256, genTime }).tokenDer,
  });
  return { recordSha256: built.recordDigest.slice("sha256:".length), bytes: built.bytes };
}

export const BUNDLE_CASES: Readonly<Record<string, () => string>> = {
  // ── `trust`, and the two `publicKey` refusals that run ahead of it ─────────────────────────────
  "trust/report-key-is-not-spki": () => goldenWith(TRUST, (trust) => {
    trust["report"].spkiDerBase64 = notAKey;
  }),
  "trust/report-key-is-not-ed25519": () => goldenWith(TRUST, (trust) => {
    trust["report"].spkiDerBase64 = FOREIGN_SPKI_BASE64.p256;
  }),
  "trust/report-did-key-is-not-derived-from-its-spki": () => goldenWith(TRUST, (trust) => {
    trust["report"].spkiDerBase64 = stranger.spkiDerBase64;
  }),
  "trust/report-key-id-differs-from-the-derived-did-key": () => goldenWith(TRUST, (trust) => {
    trust["report"].keyId = "did:key:zDifferent";
  }),
  "trust/report-did-key-alone-differs-from-the-derived-did-key": () => goldenWith(TRUST, (trust) => {
    trust["report"].didKey = "did:key:zDifferent";
  }),
  "trust/report-author-alone-differs-from-the-report": () => goldenWith(TRUST, (trust) => {
    trust["report"].author = "did:key:zDifferent";
  }),
  // The other two decoders of this value read it the same way, so the check still passes.
  "trust/report-key-spelled-url-safe-is-accepted": () => goldenWith(TRUST, (trust) => {
    trust["report"].spkiDerBase64 = urlSafe(trust["report"].spkiDerBase64 as string);
  }),
  "trust/evaluator-key-is-not-spki": () => goldenWith(TRUST, (trust) => {
    trust["evaluators"][0].spkiDerBase64 = notAKey;
  }),
  "trust/evaluator-key-is-not-ed25519": () => goldenWith(TRUST, (trust) => {
    trust["evaluators"][0].spkiDerBase64 = FOREIGN_SPKI_BASE64.p256;
  }),
  "trust/evaluator-key-id-is-not-derived-from-its-spki": () => goldenWith(TRUST, (trust) => {
    trust["evaluators"][0].keyId = "benchmark-product-verdict-0000000000000000";
  }),
  "trust/evaluator-named-twice": () => goldenWith(TRUST, (trust) => {
    trust["evaluators"].push({ ...trust["evaluators"][0] });
  }),
  "trust/evaluator-set-names-one-the-matrix-does-not": () => goldenWith(TRUST, (trust) => {
    trust["evaluators"].push({
      algorithm: "ed25519",
      evaluator: "urn:evaluator:stranger",
      keyId: stranger.keyId,
      spkiDerBase64: stranger.spkiDerBase64,
    });
  }),
  "trust/one-spki-under-two-identities": () => goldenWith(TRUST, (trust) => {
    trust["evaluators"][0].spkiDerBase64 = trust["report"].spkiDerBase64;
    trust["evaluators"][0].keyId = verdictKeyIdFromEd25519PublicKey(reportKey.publicKey);
  }),
  "trust/verdict-key-id-disagrees-with-its-evaluator": () => goldenWith("verdicts.json", (catalog) => {
    catalog["verdicts"][0].keyId = "benchmark-product-verdict-0000000000000000";
  }),
  "evidence-closure/verdict-names-another-evaluator": () => goldenWith("verdicts.json", (catalog) => {
    catalog["verdicts"][0].evaluator = "urn:evaluator:stranger";
  }),
  "evidence-closure/verdict-catalog-is-one-short": () => goldenWith("verdicts.json", (catalog) => {
    catalog["verdicts"].pop();
  }),

  // ── verify.ts around `anchor/check.ts`, through a /6 bundle ───────────────────────────────────
  "anchored-bundle/dangling-anchor": () => goldenAnchoredBy(carriedAnchorOver("3".repeat(64))),
  // Two invalid anchors, so the refusal must name the first in digest order.
  "anchored-bundle/two-dangling-anchors": () => goldenAnchoredBy(
    carriedAnchorOver("3".repeat(64)),
    carriedAnchorOver("4".repeat(64)),
  ),
  "anchored-bundle/anchor-file-is-not-named-by-its-digest": () => goldenAnchoredBy({
    ...carriedAnchorOver("3".repeat(64)),
    recordSha256: "5".repeat(64),
  }),
  "anchored-bundle/anchor-over-the-sealed-run": () => goldenAnchoredBy(carriedAnchorOver(GOLDEN_RUN_SHA256)),

  // ── profile/signing.ts, through `report-verification` ──────────────────────────────────────────
  "report-envelope/signed-by-another-key": () => goldenWithReportSignatures(
    signedBy(stranger, reportKey.keyId),
  ),
  "report-envelope/key-id-is-not-the-report-key": () => goldenWithReportSignatures(
    signedBy(reportKey, stranger.keyId),
  ),
  "report-envelope/a-stranger-signs-beside-the-report-key": () => goldenWithReportSignatures(
    allOf(signedBy(stranger), signedBy(reportKey)),
  ),

  // ── verify.ts `verifyEvidenceNativeSignature`, through a /5 bundle ─────────────────────────────
  "evidence-native-signature/valid-signature": () => evidenceNativeBundle(),
  "evidence-native-signature/flipped-signature": () => evidenceNativeBundle({
    signatures: flipped(signedBy(EVIDENCE_NATIVE_EVALUATOR)),
  }),
  "evidence-native-signature/signed-by-another-key": () => evidenceNativeBundle({
    signatures: signedBy(stranger, EVIDENCE_NATIVE_EVALUATOR.keyId),
  }),
  "evidence-native-signature/key-id-is-not-a-declared-signer": () => evidenceNativeBundle({
    signatures: signedBy(EVIDENCE_NATIVE_EVALUATOR, stranger.keyId),
  }),
  "evidence-native-signature/public-key-is-not-spki": () => evidenceNativeBundle({
    publicKeyBytes: new TextEncoder().encode("not a key"),
  }),
  "evidence-native-signature/public-key-is-not-ed25519": () => evidenceNativeBundle({
    publicKeyBytes: Buffer.from(FOREIGN_SPKI_BASE64.p256, "base64"),
  }),

  "evidence-native-signature/p256-key-with-a-signature-it-verifies": () => {
    const { spkiDer, signatures } = p256SignerUnderKeyId(EVIDENCE_NATIVE_EVALUATOR.keyId);
    return evidenceNativeBundle({ signatures, publicKeyBytes: spkiDer });
  },

  // ── verify.ts `verifyAuthoritySignature`, through a /4 operator-only closure ───────────────────
  "admission-authority-signature/valid-signature": () => operatorOnlyBundle(),
  "admission-authority-signature/flipped-signature": () => operatorOnlyBundle(
    flipped(signedBy(reportKey)),
  ),
  "admission-authority-signature/signed-by-another-key": () => operatorOnlyBundle(
    signedBy(stranger, reportKey.keyId),
  ),
  "admission-authority-signature/key-id-is-not-the-report-key": () => operatorOnlyBundle(
    signedBy(reportKey, stranger.keyId),
  ),
  "admission-authority-signature/two-signatures": () => operatorOnlyBundle(
    allOf(signedBy(reportKey), signedBy(stranger)),
  ),

  // ── verify.ts `verifyReviewerSignature`, through a /4 two-human closure ────────────────────────
  "admission-reviewer-signature/valid-signature": () => twoHumanBundle(),
  "admission-reviewer-signature/flipped-signature": () => twoHumanBundle({
    signatures: (reviewer) => flipped(signedBy(reviewer)),
  }),
  "admission-reviewer-signature/signed-by-another-key": () => twoHumanBundle({
    signatures: (reviewer) => signedBy(stranger, reviewer.keyId),
  }),
  "admission-reviewer-signature/key-id-is-not-the-reviewer-key": () => twoHumanBundle({
    signatures: (reviewer) => signedBy(reviewer, stranger.keyId),
  }),
  "admission-reviewer-signature/evaluator-carries-no-key": () => twoHumanBundle({
    evaluatorId: (index) => `urn:reviewer:absent-${index}`,
  }),
  "admission-reviewer-signature/two-signatures": () => twoHumanBundle({
    signatures: (reviewer) => allOf(signedBy(reviewer), signedBy(stranger)),
  }),
};
