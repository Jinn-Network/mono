// SPDX-License-Identifier: Apache-2.0

/**
 * The tier-1 anchor provider contract (anchor-evidence design §4.3).
 *
 * Following the §17 I/O split this package already uses (`interfaces.ts`), the
 * contract has two halves that never mix: `AnchorProofVerifier` is pure and
 * lives here in core; `AnchorProofSource` performs I/O and is implemented in
 * the application tier. This module defines **types and constants only** -- no
 * verifier is implemented here, and none may be: the conformance kit precedes
 * the first rule engine (§11).
 *
 * Two disciplines are load-bearing in the shapes below:
 *
 * - **`present` is not `verified`.** A proof whose binding and internal
 *   cryptography hold, but whose time basis no verifier-supplied trust material
 *   evaluated, is `present`. Calling it "verified" invites the reading that the
 *   *time basis* was verified, which it was not (§4.3).
 * - **Trust material is verifier-side, never bundle-supplied**, and acquisition
 *   never runs at verification time -- a verifier must not upgrade a pending
 *   proof by contacting a network mid-verification. Upgrading is a
 *   producer-side operation that appends a new record (§4.3, §6.2).
 */

/** Anchor-profile URI for the RFC 3161 timestamp-token provider (§6.1). */
export const RFC3161_TSA_ANCHOR_PROFILE =
  "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1";

/** Anchor-profile URI for the OpenTimestamps provider (§6.2). */
export const OPENTIMESTAMPS_ANCHOR_PROFILE =
  "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1";

/**
 * What a profile's time rests on (§4.1). `authority-time` is a party's signed
 * assertion -- trust reduces to that party, and such anchors never feed
 * key-binding at-time resolution. `chain-time` is a consensus commitment: no
 * single party can backdate it, given a validated chain view.
 */
export const ANCHOR_TIME_BASES = ["authority-time", "chain-time"] as const;
export type AnchorTimeBasis = (typeof ANCHOR_TIME_BASES)[number];

/**
 * What checking a profile's proof requires (§4.1) -- reported alongside the
 * time basis and never blurred into one badge.
 */
export const ANCHOR_VERIFICATION_POSTURES = [
  "offline-from-artifact",
  "offline-with-external-data",
  "lookup-only",
] as const;
export type AnchorVerificationPosture = (typeof ANCHOR_VERIFICATION_POSTURES)[number];

/**
 * The four outcomes a proof verifier reports (§4.3). `absent` and
 * `declared-but-absent` are verification-*context* outcomes owned by the
 * consuming check (§8); a proof verifier never reports them.
 */
export const ANCHOR_PROOF_STATUSES = ["verified", "present", "pending", "invalid"] as const;
export type AnchorProofStatus = (typeof ANCHOR_PROOF_STATUSES)[number];

/**
 * Binding and internal cryptography hold, and the time basis was evaluated
 * against verifier-supplied trust material (authority roots; a validated header
 * chain). `time` is the evaluated instant as calendar-strict RFC 3339 UTC --
 * for an `authority-time` proof, the pinned positional transform of the
 * token's own `genTime` (§6.1); for a `chain-time` proof, the block time read
 * from the verifier's validated header (§6.2).
 */
export interface VerifiedAnchorProof<TFacts> {
  readonly status: "verified";
  readonly profile: string;
  readonly timeBasis: AnchorTimeBasis;
  readonly time: string;
  readonly facts: TFacts;
}

/**
 * Binding and internal cryptography hold and the proof is structurally complete
 * for its class, but the material needed to evaluate its time basis was not
 * supplied. Extracted facts are reported -- they are extracted, never asserted
 * -- but no evaluated `time` is, because none was evaluated.
 */
export interface PresentAnchorProof<TFacts> {
  readonly status: "present";
  readonly profile: string;
  readonly timeBasis: AnchorTimeBasis;
  readonly facts: TFacts;
}

/** The proof is not yet independently checkable even in principle -- an
 * OpenTimestamps calendar promise with no chain attestation (§6.2). */
export interface PendingAnchorProof {
  readonly status: "pending";
  readonly profile: string;
  readonly timeBasis: AnchorTimeBasis;
  readonly reason: string;
}

/** Any rule failure: bad structure, broken signature, digest, kind, or
 * algorithm mismatch. Fails the consuming check loudly (§8). */
export interface InvalidAnchorProof {
  readonly status: "invalid";
  readonly profile: string;
  readonly reason: string;
}

/**
 * The result of verifying one proof. `TFacts` is per-profile: each profile
 * states which byte-facts it extracts (§6.1 names the RFC 3161 set; §6.2 names
 * the OpenTimestamps block height), and core never generalizes them into one
 * shape.
 */
export type AnchorProofResult<TFacts = unknown> =
  | VerifiedAnchorProof<TFacts>
  | PresentAnchorProof<TFacts>
  | PendingAnchorProof
  | InvalidAnchorProof;

export interface AnchorProofVerificationInput<TTrust> {
  /** The subject digest, recomputed by the caller from the exact sealed bytes,
   * as 64 lowercase hex characters -- the §5 DigestSet `sha256` form, without
   * the `sha256:` prefix `Sha256Digest` carries. A stored assertion is never
   * the comparison source. */
  readonly subjectSha256: string;
  /** The exact foreign proof bytes from the record, never re-encoded. */
  readonly proofBytes: Uint8Array;
  /** Verifier-side trust material; never bundle-supplied. Absent means the
   * time basis cannot be evaluated, which yields `present`, not `invalid`. */
  readonly trust?: TTrust;
}

/**
 * A pure, I/O-free proof verifier for one provider profile. Implementations
 * declare the two orthogonal facts §4.1 requires every profile to declare, so
 * verification reports and honesty copy can render them without a lookup table.
 */
export interface AnchorProofVerifier<TFacts = unknown, TTrust = unknown> {
  readonly profile: string;
  readonly timeBasis: AnchorTimeBasis;
  readonly posture: AnchorVerificationPosture;
  verifyProof(input: AnchorProofVerificationInput<TTrust>): AnchorProofResult<TFacts>;
}

export interface AnchorProofRequest {
  readonly subjectSha256: string;
  readonly endpoint: string;
  readonly signal?: AbortSignal;
}

/**
 * Acquisition for one provider profile. Application tier only: no verifier ever
 * calls this, and a source failing is an application-tier refusal, never a
 * stored artifact (§4.3).
 */
export interface AnchorProofSource {
  readonly profile: string;
  obtainProof(request: AnchorProofRequest): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// The two injected crypto ports (§6.1 "Placement"). Core produces the exact
// bytes a signature must cover and states the rules; the two platform
// primitives cross the boundary. Hand-writing an X.509 parser to make a
// security decision is the invention §3 exists to prevent.
// ---------------------------------------------------------------------------

export interface AnchorSignatureVerificationInput {
  /** Dotted-string signature algorithm OID from the SignerInfo. */
  readonly algorithmOid: string;
  /** Exact DER of `AlgorithmIdentifier.parameters` when present -- RSASSA-PSS
   * carries its digest and salt there. */
  readonly parameters?: Uint8Array;
  /** Exact DER SubjectPublicKeyInfo of the signer certificate. */
  readonly spkiDer: Uint8Array;
  /** The exact bytes the signature covers -- for RFC 3161, the DER re-encoding
   * of `signedAttrs` under an explicit SET OF tag (§6.1 rule 8). */
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
}

export interface AnchorSignatureVerifier {
  verifySignature(input: AnchorSignatureVerificationInput): boolean;
}

/**
 * How a certificate names itself, and how `SignerInfo.sid` names a
 * certificate. Both CMS forms are modeled, and both are compared as bytes:
 * §6.1 keeps distinguished names out of byte-compared facts because
 * DN-to-string rendering is not canonical across implementations.
 */
export type AnchorSignerIdentifier =
  | {
    readonly kind: "issuerAndSerialNumber";
    /** Exact DER of the issuer `Name`. */
    readonly issuerDer: Uint8Array;
    /** Content octets of the serial `INTEGER`, big-endian two's complement. */
    readonly serialNumber: Uint8Array;
  }
  | {
    readonly kind: "subjectKeyIdentifier";
    readonly keyIdentifier: Uint8Array;
  };

export interface AnchorCertificateFacts {
  readonly subjectPublicKeyInfoDer: Uint8Array;
  /** Validity bounds as calendar-strict RFC 3339 UTC, so §6.1 rule 11's window
   * check runs through the same comparator as every other trust instant. */
  readonly notBefore: string;
  readonly notAfter: string;
  /** Every extended key usage the certificate asserts. §6.1 rule 9 requires
   * exactly `id-kp-timeStamping`; extension criticality is a recorded gap
   * (§16 item 4), not silently assumed. */
  readonly extendedKeyUsageOids: readonly string[];
  /** Exact DER of each `GeneralName` the certificate presents for itself --
   * what §6.1 rule 10 compares the TSTInfo `tsa` field against, by bytes. */
  readonly subjectNames: readonly Uint8Array[];
  /** Every identifier form this certificate supports: `issuerAndSerialNumber`
   * always, and `subjectKeyIdentifier` when the extension is present. §6.1
   * rule 7 accepts a `SignerInfo.sid` matching any of them -- a single form
   * could not answer a token that named the certificate the other way. */
  readonly sid: readonly AnchorSignerIdentifier[];
}

export interface AnchorCertificateReader {
  readCertificate(certificateDer: Uint8Array): AnchorCertificateFacts;
}
