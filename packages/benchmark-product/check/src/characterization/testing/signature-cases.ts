// SPDX-License-Identifier: Apache-2.0

/**
 * The primitives the record-verification move lifts out of this package, called directly over the
 * branches a whole bundle cannot tell apart: both `profile/signing.ts` and
 * `profile/assembly-ports.ts` answer every failure with the same empty result, and did:key derivation
 * sits in front of a check that only ever feeds it Ed25519.
 *
 * Both sites read envelopes with the lenient `parseDsseEnvelope`, and that is pinned here. The
 * admission ports in `verify.ts` use the exact parser, but `admission/verification.ts` has parsed
 * each envelope and counted its signatures before they run, so their own copy changes no output
 * and no pin can see it.
 */

import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRun } from "@jinn-network/benchmarking-records";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { parseDsseEnvelope, sha256Hex } from "@jinn-network/trust-core";
import {
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
  keyFingerprintFromDidKey,
} from "../../identity/did-key.js";
import {
  buildAssemblyPortsFromFacts,
  type AssemblyPublicKeyRecord,
} from "../../profile/assembly-ports.js";
import { didKeyFromEd25519PublicKey, verifyReportEnvelopeSignatures } from "../../profile/signing.js";
import { GOLDEN_BUNDLE_DIR } from "../../testing/golden-asset-input.js";
import { settled } from "./observe.js";
import {
  FOREIGN_SPKI_BASE64,
  allOf,
  flipped,
  kitReportSigner,
  p256SignerUnderKeyId,
  sealSigned,
  signedBy,
  signerFromLabel,
  type DsseSignatures,
  type PinnedSigner,
} from "./signers.js";

type Case = () => unknown;

const stranger = signerFromLabel("stranger");
const reportKey = kitReportSigner();
const encoder = new TextEncoder();
const reportKeyIdP256 = p256SignerUnderKeyId(reportKey.keyId);

function goldenBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(GOLDEN_BUNDLE_DIR, path)));
}

function respelled(envelope: Uint8Array): Uint8Array {
  return encoder.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(envelope)), null, 2));
}

function urlSafeSignature(envelope: Uint8Array): Uint8Array {
  const parsed = JSON.parse(new TextDecoder().decode(envelope)) as { signatures: { sig: string }[] };
  for (const signature of parsed.signatures) {
    // A signature with neither character reads the same in both alphabets and would prove nothing.
    if (!/[+/]/u.test(signature.sig)) throw new Error("signature has no URL-unsafe character");
    signature.sig = signature.sig.replaceAll("+", "-").replaceAll("/", "_");
  }
  return encoder.encode(JSON.stringify(parsed));
}

// ── profile/signing.ts `verifyReportEnvelopeSignatures` ──────────────────────────────────────────

const goldenEnvelope = goldenBytes("report-envelope.json");
const goldenPayload = parseDsseEnvelope(goldenEnvelope);

function reportEnvelope(signatures: DsseSignatures): Uint8Array {
  return sealSigned(goldenPayload.payloadType, goldenPayload.payloadBytes, signatures);
}

function reportSigners(envelope: Uint8Array, key: Pick<PinnedSigner, "keyId" | "publicKey"> = reportKey): Case {
  return () => verifyReportEnvelopeSignatures(envelope, key);
}

// ── profile/assembly-ports.ts `resolveEvaluatorClaim` ────────────────────────────────────────────

const EVALUATOR = "urn:evaluator:characterization";
const OWNER = "urn:owner:characterization";
const evaluatorKey = signerFromLabel(EVALUATOR);
const evaluatorKeyIdP256 = p256SignerUnderKeyId(evaluatorKey.keyId);
const payload = encoder.encode('{"statement":"evaluated"}');

function verdict(signatures: DsseSignatures): Uint8Array {
  return sealSigned(VERDICT_DSSE_PAYLOAD_TYPE, payload, signatures);
}

interface ResolveInput {
  readonly evidence?: unknown;
  readonly envelope?: Uint8Array;
  readonly keys?: ReadonlyMap<string, AssemblyPublicKeyRecord>;
}

function resolvedAgent(input: ResolveInput): Case {
  const envelope = input.envelope ?? verdict(signedBy(evaluatorKey));
  const digest = sha256Hex(envelope);
  const keys = input.keys ?? new Map([[EVALUATOR, evaluatorKey]]);
  return () => buildAssemblyPortsFromFacts({
    runRecord: parseRun(goldenBytes("run.json")),
    cells: [],
    owner: OWNER,
    runCancelled: false,
    receiptsByTaskDigest: new Map(),
    resolveBytes: (requested) => {
      if (requested !== digest) throw new Error(`no record ${requested}`);
      return envelope;
    },
    evaluatorKeys: () => keys,
  }).trust.resolveAgent(
    input.evidence ?? { role: "evaluator", claim: EVALUATOR, verdictDigest: `sha256:${digest}` },
    new Date(0),
  );
}

// ── did:key, derivation and decoding ─────────────────────────────────────────────────────────────

const GOLDEN_DID_KEY = "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX";

function derivedDidKey(spkiDerBase64: string): Case {
  return () => settled(() => didKeyFromEd25519PublicKey(createPublicKey({
    key: Buffer.from(spkiDerBase64, "base64"),
    format: "der",
    type: "spki",
  })));
}

function decodedDidKey(keyId: string): Case {
  return () => {
    const bytes = ed25519PublicKeyBytesFromDidKey(keyId);
    return {
      publicKeyHex: bytes === undefined ? null : Buffer.from(bytes).toString("hex"),
      spkiDerBase64: ed25519PublicKeyFromDidKey(keyId)?.export({ format: "der", type: "spki" }).toString("base64") ?? null,
      fingerprint: keyFingerprintFromDidKey(keyId) ?? null,
    };
  };
}

export const SIGNATURE_CASES: Readonly<Record<string, Case>> = {
  "report-envelope-signatures/golden-envelope": reportSigners(goldenEnvelope),
  "report-envelope-signatures/flipped-signature": reportSigners(reportEnvelope(flipped(signedBy(reportKey)))),
  "report-envelope-signatures/signed-by-another-key": reportSigners(reportEnvelope(signedBy(stranger, reportKey.keyId))),
  "report-envelope-signatures/key-id-is-not-the-report-key": reportSigners(reportEnvelope(signedBy(reportKey, stranger.keyId))),
  "report-envelope-signatures/a-stranger-signs-first": reportSigners(reportEnvelope(allOf(signedBy(stranger), signedBy(reportKey)))),
  "report-envelope-signatures/the-report-key-signs-twice": reportSigners(reportEnvelope(allOf(signedBy(reportKey), signedBy(reportKey)))),
  "report-envelope-signatures/respelled-envelope-is-accepted": reportSigners(respelled(goldenEnvelope)),
  "report-envelope-signatures/url-safe-signature-is-accepted": reportSigners(urlSafeSignature(goldenEnvelope)),
  "report-envelope-signatures/not-an-envelope": reportSigners(encoder.encode("not an envelope")),
  "report-envelope-signatures/verifying-key-is-not-ed25519": reportSigners(goldenEnvelope, {
    keyId: reportKey.keyId,
    publicKey: createPublicKey({ key: Buffer.from(FOREIGN_SPKI_BASE64.p256, "base64"), format: "der", type: "spki" }),
  }),

  "report-envelope-signatures/p256-key-with-a-signature-it-verifies": reportSigners(
    reportEnvelope(reportKeyIdP256.signatures),
    { keyId: reportKey.keyId, publicKey: reportKeyIdP256.publicKey },
  ),

  "evaluator-claim/valid-signature": resolvedAgent({}),
  "evaluator-claim/solver-role-resolves-to-the-owner": resolvedAgent({ evidence: { role: "solver" } }),
  "evaluator-claim/no-role": resolvedAgent({ evidence: { claim: EVALUATOR } }),
  "evaluator-claim/claim-is-not-a-string": resolvedAgent({ evidence: { role: "evaluator", claim: 1, verdictDigest: "sha256:00" } }),
  "evaluator-claim/digest-has-no-prefix": resolvedAgent({ evidence: { role: "evaluator", claim: EVALUATOR, verdictDigest: "00" } }),
  "evaluator-claim/no-key-for-the-claim": resolvedAgent({ keys: new Map() }),
  "evaluator-claim/record-is-not-carried": resolvedAgent({ evidence: { role: "evaluator", claim: EVALUATOR, verdictDigest: "sha256:00" } }),
  "evaluator-claim/flipped-signature": resolvedAgent({ envelope: verdict(flipped(signedBy(evaluatorKey))) }),
  "evaluator-claim/signed-by-another-key": resolvedAgent({ envelope: verdict(signedBy(stranger, evaluatorKey.keyId)) }),
  "evaluator-claim/key-id-is-not-the-evaluator-key": resolvedAgent({ envelope: verdict(signedBy(evaluatorKey, stranger.keyId)) }),
  "evaluator-claim/a-stranger-signs-first": resolvedAgent({ envelope: verdict(allOf(signedBy(stranger), signedBy(evaluatorKey))) }),
  "evaluator-claim/respelled-envelope-is-accepted": resolvedAgent({ envelope: respelled(verdict(signedBy(evaluatorKey))) }),
  "evaluator-claim/url-safe-signature-is-accepted": resolvedAgent({ envelope: urlSafeSignature(verdict(signedBy(evaluatorKey))) }),
  // The same length as `sha256:`, so the digest still resolves and only the prefix test can refuse.
  "evaluator-claim/digest-has-another-prefix": resolvedAgent({
    evidence: { role: "evaluator", claim: EVALUATOR, verdictDigest: `sha512:${sha256Hex(verdict(signedBy(evaluatorKey)))}` },
  }),
  "evaluator-claim/p256-key-with-a-signature-it-verifies": resolvedAgent({
    envelope: verdict(evaluatorKeyIdP256.signatures),
    keys: new Map([[EVALUATOR, { keyId: evaluatorKey.keyId, publicKey: evaluatorKeyIdP256.publicKey }]]),
  }),

  "did-key-derivation/golden-report-key": derivedDidKey(readGoldenReportSpki()),
  "did-key-derivation/label-derived-key": derivedDidKey(evaluatorKey.spkiDerBase64),
  "did-key-derivation/p256-key-is-not-refused": derivedDidKey(FOREIGN_SPKI_BASE64.p256),
  "did-key-derivation/p384-key": derivedDidKey(FOREIGN_SPKI_BASE64.p384),
  "did-key-derivation/rsa-key": derivedDidKey(FOREIGN_SPKI_BASE64.rsa),

  "did-key-decoding/golden-report-key": decodedDidKey(GOLDEN_DID_KEY),
  "did-key-decoding/not-a-did": decodedDidKey("not-a-did"),
  "did-key-decoding/another-did-method": decodedDidKey("did:web:example.com"),
  "did-key-decoding/empty-payload": decodedDidKey("did:key:z"),
  "did-key-decoding/character-outside-the-alphabet": decodedDidKey("did:key:z0OIl"),
  // A real key's length, so only the alphabet test can refuse it.
  "did-key-decoding/character-outside-the-alphabet-at-key-length": decodedDidKey(`${GOLDEN_DID_KEY.slice(0, -1)}0`),
  // The Ed25519 multicodec on a 31-byte body, so only the length test can refuse it.
  "did-key-decoding/ed25519-prefix-on-a-short-key": decodedDidKey("did:key:z2DQUz8nFdBkV4MKdqWGtQB9BsNUCioEPREBUjj3hFW95f6"),
  "did-key-decoding/payload-one-digit-too-long": decodedDidKey(`did:key:z${"1".repeat(48)}`),
  "did-key-decoding/too-short-for-a-key": decodedDidKey("did:key:z6Mk"),
  "did-key-decoding/secp256k1-key": decodedDidKey("did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme"),
  // The same payload length as Ed25519, so only the multicodec prefix tells them apart.
  "did-key-decoding/x25519-key": decodedDidKey("did:key:z6LSeu9HkTHSfLLeUs2nnzUSNedgDUevfNQgQjQC23ZCit6F"),
};

function readGoldenReportSpki(): string {
  const trust = JSON.parse(new TextDecoder().decode(goldenBytes("trust/public-keys.json"))) as {
    readonly report: { readonly spkiDerBase64: string };
  };
  return trust.report.spkiDerBase64;
}
