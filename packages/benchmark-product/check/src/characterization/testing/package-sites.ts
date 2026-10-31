// SPDX-License-Identifier: Apache-2.0

/**
 * Every place the runtime switch of issue #5120 will call `@jinn-network/verify`, written the way
 * that switch will write it: the package call with its mapped options, plus whatever the local site
 * does around the call and keeps doing. `package-equivalence.test.ts` runs each of these beside the
 * code it replaces, so what passes here is the code to move into `src/`.
 */

import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import type { EvidenceNativeSignatureVerificationInput } from "@jinn-network/benchmarking-evidence";
import { failClosedTrustResolver } from "@jinn-network/benchmarking-local";
import {
  MATRIX_RECORD_KIND,
  RUN_RECORD_KIND,
  compareCalendarStrictRfc3339Instants,
} from "@jinn-network/benchmarking-records";
import {
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyBytesFromDidKey,
  evaluateAnchors,
  verifyDsseSignatures,
  verifyEd25519Signature,
  type AnchorProofContext,
  type AnchorRefusal,
  type DsseVerificationKey,
} from "@jinn-network/verify";
import type {
  EvaluateIntegrityAnchorsInput,
  IntegrityAnchorsReport,
} from "../../anchor/check.js";
import type { AdmissionAuthorityRole } from "../../admission/verification.js";
import type { BuildAssemblyPortsFromFactsInput } from "../../profile/assembly-ports.js";
import type { ClaimAnchorSubject } from "../../profile/anchor-claims.js";
import type { BundleV4Trust } from "../../schema.js";

/** `verify.ts` `verifyEvidenceNativeSignature`. */
export function evidenceNativeSignature(input: EvidenceNativeSignatureVerificationInput): boolean {
  return verifyEd25519Signature(input.publicKeyBytes, input.preAuthEncoding, input.signature);
}

/** What `verifyPublicBundleSnapshot` holds by the time its two admission ports run. */
export interface AdmissionKeys {
  readonly reportKey: KeyObject;
  readonly evaluatorKeys: ReadonlyMap<string, DsseVerificationKey>;
  readonly trust: BundleV4Trust;
}

/** `verify.ts` `verifyReviewerSignature`. The first two lines stay local. */
export function reviewerSignature(
  input: { readonly envelopeBytes: Uint8Array; readonly evaluatorId: string; readonly keyId: string },
  keys: AdmissionKeys,
): boolean {
  const key = keys.evaluatorKeys.get(input.evaluatorId);
  if (key === undefined || key.keyId !== input.keyId) return false;
  return verifyDsseSignatures(input.envelopeBytes, [key], {
    requireSingleSignature: true,
  }).validSignerKeyids.length === 1;
}

/** `verify.ts` `verifyAuthoritySignature`. The first two lines stay local. */
export function authoritySignature(
  input: { readonly envelopeBytes: Uint8Array; readonly keyId: string; readonly role: AdmissionAuthorityRole },
  keys: AdmissionKeys,
): boolean {
  const binding = keys.trust.admission.authorities.find((candidate) => candidate.role === input.role);
  if (binding?.keyId !== input.keyId || input.keyId !== keys.trust.report.keyId) return false;
  return verifyDsseSignatures(input.envelopeBytes, [{ keyId: input.keyId, publicKey: keys.reportKey }], {
    requireSingleSignature: true,
  }).validSignerKeyids.length === 1;
}

/** `profile/signing.ts` `verifyReportEnvelopeSignatures`. */
export function reportEnvelopeSignatures(
  envelopeBytes: Uint8Array,
  key: DsseVerificationKey,
): { validSignerKeyids: readonly string[] } {
  return verifyDsseSignatures(envelopeBytes, [key], {
    allowRespelledEnvelope: true,
    allowNonEd25519Keys: true,
    keepRepeatedSigners: true,
  });
}

/** `profile/assembly-ports.ts` `resolveEvaluatorClaim`. Everything but the signature test stays local. */
function evaluatorClaim(
  resolveBytes: (digest: string) => Uint8Array,
  evidenceRef: unknown,
  loadKeys: BuildAssemblyPortsFromFactsInput["evaluatorKeys"],
): string | "unresolved" {
  try {
    const ref = evidenceRef as { claim?: unknown; verdictDigest?: unknown } | undefined;
    if (typeof ref?.claim !== "string" || typeof ref.verdictDigest !== "string" || !ref.verdictDigest.startsWith("sha256:")) return "unresolved";
    const key = loadKeys().get(ref.claim);
    if (key === undefined) return "unresolved";
    const { validSignerKeyids } = verifyDsseSignatures(resolveBytes(ref.verdictDigest.slice("sha256:".length)), [key], {
      allowRespelledEnvelope: true,
      allowNonEd25519Keys: true,
    });
    return validSignerKeyids.length > 0 ? ref.claim : "unresolved";
  } catch { return "unresolved"; }
}

/** `profile/assembly-ports.ts`, the `trust` port `buildAssemblyPortsFromFacts` hands `verifyMatrix`. */
export function resolveAgent(
  input: BuildAssemblyPortsFromFactsInput,
  evidenceRef: unknown,
  at: Date,
): Promise<string> {
  return failClosedTrustResolver({
    resolveAgent: async (ref) => {
      const role = (ref as { role?: unknown } | undefined)?.role;
      if (role === "solver") return input.owner;
      return role === "evaluator" ? evaluatorClaim(input.resolveBytes, ref, input.evaluatorKeys) : "unresolved";
    },
  }).resolveAgent(evidenceRef, at);
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * `profile/signing.ts` `didKeyFromEd25519PublicKey`, with the two outputs the package does not give.
 * The package refuses every key but Ed25519, and the characterization suite pins what this one does
 * instead: a key with a 32-byte `x` comes back spelled as a did:key, and any other throws its own
 * message. Wrapping those 32 bytes as an Ed25519 key is what lets the encoder stay in the package.
 */
export function didKeyKeepingPinnedOutput(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("Ed25519 public key JWK export is missing its x-coordinate");
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw new Error(`Ed25519 public key raw bytes must be 32 bytes, got ${raw.length}`);
  return didKeyFromEd25519PublicKey(createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  }));
}

/** `identity/did-key.ts` `keyFingerprintFromDidKey`, which stays local over the package's decoder. */
export function keyFingerprint(keyId: string): string | undefined {
  const raw = ed25519PublicKeyBytesFromDidKey(keyId);
  return raw === undefined ? undefined : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

const SUBJECT_NAMES: Readonly<Record<ClaimAnchorSubject, string>> = { lock: "Run", matrix: "Matrix" };

function colophonAnchorReason(refusal: AnchorRefusal<ClaimAnchorSubject>): string | undefined {
  switch (refusal.code) {
    case "unknown-subject":
      return `the anchored digest ${refusal.digest} is neither this bundle's sealed Run nor its sealed Matrix`;
    case "subject-kind-mismatch":
      return `subject.kind is ${refusal.kind}, but its digest resolves to this bundle's sealed ${SUBJECT_NAMES[refusal.subject]}`;
    default:
      return undefined;
  }
}

/** The splice-catch: an `authority-time` lock anchor must not postdate the Run's own close instant. */
function spliceCatch(closeAt: string) {
  return ({ subject, timeBasis, facts }: AnchorProofContext<ClaimAnchorSubject>): string | undefined => {
    if (subject !== "lock" || timeBasis !== "authority-time") return undefined;
    const genTime = (facts as { readonly genTime?: unknown }).genTime;
    if (typeof genTime !== "string") return "an authority-time lock anchor carries no comparable genTime";
    const compared = compareCalendarStrictRfc3339Instants(genTime, closeAt);
    return compared === undefined || compared > 0
      ? `the token's genTime ${genTime} is after this run's own pre-registered close instant ${closeAt}`
      : undefined;
  };
}

/** `anchor/check.ts` `evaluateIntegrityAnchors`. */
export function integrityAnchors(input: EvaluateIntegrityAnchorsInput): IntegrityAnchorsReport {
  return evaluateAnchors<ClaimAnchorSubject>({
    records: input.records,
    subjects: [
      {
        id: "lock",
        sha256: input.runSha256,
        kind: RUN_RECORD_KIND,
        ...(input.declaredProfiles === undefined ? {} : { declaredProfiles: input.declaredProfiles }),
      },
      { id: "matrix", sha256: input.matrixSha256, kind: MATRIX_RECORD_KIND },
    ],
    ...(input.trust === undefined ? {} : { trust: input.trust }),
    renderReason: colophonAnchorReason,
    rejectProof: spliceCatch(input.closeAt),
  });
}
