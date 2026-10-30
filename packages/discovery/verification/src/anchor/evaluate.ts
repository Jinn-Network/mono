// SPDX-License-Identifier: Apache-2.0

/**
 * Whether anchor evidence stands up for the records it names (pluggable integrity providers design
 * §8). It takes the subjects as data, so one implementation serves any record a caller holds.
 *
 * It never throws, and every carried record gets an outcome: the point of the check is to report
 * on all of them, and a caller that wants to refuse decides that from the returned statuses.
 *
 * - **Exact bytes, strict schema.** Unknown keys fail closed.
 * - **The subject is recomputed, never read.** The caller hashes the bytes it holds. Selection is by
 *   digest, so a `subject.kind` label can never route an anchor onto a record its digest does not
 *   back. The kind is then checked for equality, and a mismatch is invalid.
 * - **Trust material is the verifier's.** None ships. Absent roots or headers yield `present`, not
 *   `invalid`: an incomplete root set is no accusation against the proof.
 * - **Absence is an outcome.** A subject with no carried anchor reports `absent`, and one that
 *   declared an anchor it does not have reports `declared-but-absent`, so a stripped anchor cannot
 *   pass for one never attempted.
 */

import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  compareCodeUnitStrings,
  createOpenTimestampsProofVerifier,
  createRfc3161AnchorProofVerifier,
  decodeAnchorProofContent,
  parseExactAnchorEvidence,
} from "@jinn-network/trust-core";
import type {
  AnchorProofResult,
  AnchorTimeBasis,
  OpenTimestampsTrustMaterial,
  Rfc3161AnchorTrustMaterial,
} from "@jinn-network/trust-core";

import { describeError } from "../results.js";
import { nodeCryptoAnchorPorts } from "./ports.js";

/** Keyed by provider profile. An empty set can never yield `verified`. */
export interface AnchorTrustMaterial {
  readonly rfc3161?: Rfc3161AnchorTrustMaterial;
  readonly opentimestamps?: OpenTimestampsTrustMaterial;
}

export interface CarriedAnchorRecord {
  /** The bare hex digest of `bytes`. */
  readonly recordSha256: string;
  readonly bytes: Uint8Array;
}

/** A record anchors may name. Pass the digest of bytes you hold, never one read from a record. */
export interface AnchorSubject<Id extends string = string> {
  /** How entries refer to this subject. */
  readonly id: Id;
  /** The bare hex digest of the record's exact bytes. */
  readonly sha256: string;
  /** The record's kind, compared with the anchor's `subject.kind`. Omit when it cannot be named. */
  readonly kind?: string;
  /** Provider profiles the record declares it will be anchored under. */
  readonly declaredProfiles?: readonly string[];
}

/** Why a record was refused before any proof verifier ran. */
export type AnchorRefusal<Id extends string = string> =
  | { readonly code: "not-anchor-evidence"; readonly message: string }
  | { readonly code: "unknown-subject"; readonly digest: string }
  | { readonly code: "subject-kind-mismatch"; readonly kind: string; readonly subject: Id }
  | { readonly code: "no-proof-verifier"; readonly provider: string };

export type AnchorProofStatus = AnchorProofResult["status"];

export interface AnchorVerificationEntry<Id extends string = string> {
  readonly recordSha256: string;
  readonly status: AnchorProofStatus;
  /** Absent only when the record did not parse at all. */
  readonly provider?: string;
  /** Absent on an anchor naming no subject, by definition. */
  readonly subject?: Id;
  readonly timeBasis?: AnchorTimeBasis;
  /** Present only on `verified`, the one status where a time was evaluated against material. */
  readonly time?: string;
  /** The profile's byte facts, on `verified` and `present`. */
  readonly facts?: unknown;
  /** Why the proof is `pending` or `invalid`. */
  readonly reason?: string;
  /** Whether this reader had material for this profile. Never a fact about the record. */
  readonly trustMaterial: "supplied" | "none";
}

export interface AnchorSubjectReport<Id extends string = string> {
  readonly subject: Id;
  readonly outcome: "anchored" | "absent" | "declared-but-absent";
  /** Declared profiles with no matching anchor. Present only on `declared-but-absent`. */
  readonly declaredProfiles?: readonly string[];
}

export interface AnchorsReport<Id extends string = string> {
  /** One entry per carried record, in record-digest order. */
  readonly anchors: readonly AnchorVerificationEntry<Id>[];
  readonly subjects: readonly AnchorSubjectReport<Id>[];
  /** The subset a caller refuses on. Empty means nothing was invalid. */
  readonly invalid: readonly AnchorVerificationEntry<Id>[];
}

/** What a caller's own rule sees: a proof that passed its verifier, for a subject that resolved. */
export interface AnchorProofContext<Id extends string = string> {
  readonly subject: Id;
  readonly timeBasis: AnchorTimeBasis;
  /** The profile's byte facts, available with or without trust material. */
  readonly facts: unknown;
}

export interface EvaluateAnchorsInput<Id extends string = string> {
  readonly records: readonly CarriedAnchorRecord[];
  readonly subjects: readonly AnchorSubject<Id>[];
  readonly trust?: AnchorTrustMaterial;
  /** Words for a refusal. Return `undefined` to keep the default wording. */
  renderReason?(refusal: AnchorRefusal<Id>): string | undefined;
  /** A rule of the caller's that can still refuse a sound proof. Returns the reason, if refused. */
  rejectProof?(proof: AnchorProofContext<Id>): string | undefined;
}

function defaultReason<Id extends string>(refusal: AnchorRefusal<Id>): string {
  switch (refusal.code) {
    case "not-anchor-evidence":
      return `not the exact sealed encoding of a conforming AnchorEvidence record: ${refusal.message}`;
    case "unknown-subject":
      return `the anchored digest ${refusal.digest} names none of the subjects supplied`;
    case "subject-kind-mismatch":
      return `subject.kind is ${refusal.kind}, but its digest resolves to subject ${refusal.subject}`;
    case "no-proof-verifier":
      return `no proof verifier implements the anchor profile ${refusal.provider}`;
  }
}

function invalidEntry<Id extends string>(
  recordSha256: string,
  reason: string,
  extra: Partial<AnchorVerificationEntry<Id>> = {},
): AnchorVerificationEntry<Id> {
  return { recordSha256, status: "invalid", reason, trustMaterial: "none", ...extra };
}

function evaluateRecord<Id extends string>(
  carried: CarriedAnchorRecord,
  input: EvaluateAnchorsInput<Id>,
): AnchorVerificationEntry<Id> {
  const reasonFor = (refusal: AnchorRefusal<Id>): string => input.renderReason?.(refusal) ?? defaultReason(refusal);

  let record: ReturnType<typeof parseExactAnchorEvidence>;
  let proofBytes: Uint8Array;
  try {
    record = parseExactAnchorEvidence(carried.bytes);
    proofBytes = decodeAnchorProofContent(record.proof.content);
  } catch (cause) {
    return invalidEntry(carried.recordSha256, reasonFor({ code: "not-anchor-evidence", message: describeError(cause) }));
  }

  const provider = record.provider;
  const subjectDigest = record.subject.digest.sha256;
  const resolved = input.subjects.find(({ sha256 }) => sha256 === subjectDigest);
  if (resolved === undefined) {
    return invalidEntry(carried.recordSha256, reasonFor({ code: "unknown-subject", digest: subjectDigest }), { provider });
  }
  const subject = resolved.id;
  if (resolved.kind !== undefined && record.subject.kind !== resolved.kind) {
    return invalidEntry(
      carried.recordSha256,
      reasonFor({ code: "subject-kind-mismatch", kind: record.subject.kind, subject }),
      { provider, subject },
    );
  }

  const isRfc3161 = provider === RFC3161_TSA_ANCHOR_PROFILE;
  if (!isRfc3161 && provider !== OPENTIMESTAMPS_ANCHOR_PROFILE) {
    return invalidEntry(carried.recordSha256, reasonFor({ code: "no-proof-verifier", provider }), { provider, subject });
  }
  const material = isRfc3161 ? input.trust?.rfc3161 : input.trust?.opentimestamps;
  const result: AnchorProofResult = isRfc3161
    ? createRfc3161AnchorProofVerifier(nodeCryptoAnchorPorts).verifyProof({
      subjectSha256: subjectDigest,
      proofBytes,
      ...(input.trust?.rfc3161 === undefined ? {} : { trust: input.trust.rfc3161 }),
    })
    : createOpenTimestampsProofVerifier().verifyProof({
      subjectSha256: subjectDigest,
      proofBytes,
      ...(input.trust?.opentimestamps === undefined ? {} : { trust: input.trust.opentimestamps }),
    });
  const trustMaterial = material === undefined ? "none" as const : "supplied" as const;
  const base = { recordSha256: carried.recordSha256, provider, subject, trustMaterial };
  if (result.status === "invalid") return { ...base, status: "invalid", reason: result.reason };
  if (result.status === "pending") {
    return { ...base, status: "pending", timeBasis: result.timeBasis, reason: result.reason };
  }
  // A fifth member of ANCHOR_PROOF_STATUSES fails here rather than arriving below unhandled.
  result.status satisfies "verified" | "present";

  const rejection = input.rejectProof?.({ subject, timeBasis: result.timeBasis, facts: result.facts });
  if (rejection !== undefined) return invalidEntry(carried.recordSha256, rejection, { provider, subject });
  return {
    ...base,
    status: result.status,
    timeBasis: result.timeBasis,
    ...(result.status === "verified" ? { time: result.time } : {}),
    facts: result.facts,
  };
}

/** Reports every carried anchor record and every subject. Never throws on what a record contains. */
export function evaluateAnchors<Id extends string = string>(input: EvaluateAnchorsInput<Id>): AnchorsReport<Id> {
  const anchors = [...input.records]
    .sort((left, right) => compareCodeUnitStrings(left.recordSha256, right.recordSha256))
    .map((carried) => evaluateRecord(carried, input));

  const subjects = input.subjects.map(({ id, declaredProfiles = [] }): AnchorSubjectReport<Id> => {
    const carried = anchors.filter((entry) => entry.subject === id && entry.status !== "invalid");
    const missing = declaredProfiles.filter((profile) => !carried.some((entry) => entry.provider === profile));
    if (missing.length > 0) {
      return { subject: id, outcome: "declared-but-absent", declaredProfiles: [...missing].sort(compareCodeUnitStrings) };
    }
    return { subject: id, outcome: carried.length > 0 ? "anchored" : "absent" };
  });

  return { anchors, subjects, invalid: anchors.filter((entry) => entry.status === "invalid") };
}
