/**
 * The `integrity-anchors` check (anchor-evidence design §8): the one shared implementation both
 * `bundle verify` and the workspace-side `run.verify` report through.
 *
 * It never throws. Every carried anchor gets an outcome, because the check's whole purpose is to
 * report on all of them — one unreadable proof must not take the report down with it, and a caller
 * that wants to refuse decides that from the returned statuses rather than from an exception that
 * escaped mid-walk. The callers refuse `record-integrity` on any `invalid`, which is the design's
 * "fails the whole verification loudly".
 *
 * Four rules do the work, and each is a different attack:
 *
 * 1. **Exact-bytes parse, strict schema.** Unknown keys fail closed — the public-bundle closure
 *    discipline, deliberately stricter than the protocol layer's unknown-field tolerance.
 * 2. **The subject is recomputed, never read.** The digest comes from the authenticated snapshot's
 *    own `run.json` / `matrix.json` bytes; a stored assertion is never the comparison source.
 *    Selectors are digest-keyed, so a `subject.kind` label can never route an anchor onto a claim
 *    its digest does not back — the kind is then *checked* for equality, and a mismatch is
 *    `invalid`.
 * 3. **Trust material is verifier-side.** None ships. Absent roots or headers yield `present`, not
 *    `invalid`: an operator's incomplete root set is not an accusation against the proof, and
 *    authority acceptability is consumer policy. Bundle-carried certificate chains are archival and
 *    are never used to validate.
 * 4. **The splice-catch.** An `authority-time` lock anchor must satisfy `genTime <= run.closeAt`.
 *    It reads `facts.genTime`, which both `verified` and `present` carry — routing it through the
 *    evaluated `time` instead would silently disable it in the default no-roots configuration,
 *    which is the configuration nearly every reader is in. It catches an anchor spliced in after
 *    the run's own pre-registered close instant, and nothing more; it is not ordering evidence and
 *    is never described as such. Chain-time proofs carry no time, so the rule does not reach them.
 *
 * Absence is an outcome, not a silence: a subject with no carried anchor reports `absent`, and one
 * whose sealed Run declared anchoring intent that the bundle does not satisfy reports
 * `declared-but-absent`. Both pass. A stripped anchor cannot masquerade as never-attempted.
 */

import {
  MATRIX_RECORD_KIND,
  RUN_RECORD_KIND,
  compareCalendarStrictRfc3339Instants,
} from "@jinn-network/benchmarking-records";
import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
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
import type { CarriedAnchorRecord, ClaimAnchorSubject } from "../profile/anchor-claims.js";
import { nodeCryptoAnchorPorts } from "./ports.js";

/**
 * Verifier-side trust material, keyed by provider profile. Strictly the verifier operator's own
 * configuration: this package ships none, and an empty set can never yield `verified` (§8 step 3).
 */
export interface PublicBundleAnchorTrustMaterial {
  readonly rfc3161?: Rfc3161AnchorTrustMaterial;
  readonly opentimestamps?: OpenTimestampsTrustMaterial;
}

/** §4.3's four proof outcomes. `absent` and `declared-but-absent` are per-subject context outcomes
 * this check owns; a proof verifier never reports them. */
export type AnchorProofStatus = AnchorProofResult["status"];

/** §7.3's absence semantics, plus the positive case. */
export type AnchorSubjectOutcome = "anchored" | "absent" | "declared-but-absent";

export interface AnchorVerificationEntry {
  readonly recordSha256: string;
  readonly status: AnchorProofStatus;
  /** The provider profile the record names. Absent only when the record did not parse at all. */
  readonly provider?: string;
  /** The subject the record's digest resolves to. Absent on a dangling anchor by definition. */
  readonly subject?: ClaimAnchorSubject;
  readonly timeBasis?: AnchorTimeBasis;
  /** The evaluated instant, present only on `verified` — the one status where a time basis was
   * actually evaluated against supplied material. */
  readonly time?: string;
  /** The profile's extracted byte-facts, reported for `verified` and `present`. */
  readonly facts?: unknown;
  /** Why the proof is `pending` or `invalid`. */
  readonly reason?: string;
  /** The verifier's own evaluation disclosure: whether this reader had material for this profile at
   * all. It is never a fact about the bundle. */
  readonly trustMaterial: "supplied" | "none";
}

export interface AnchorSubjectReport {
  readonly subject: ClaimAnchorSubject;
  readonly outcome: AnchorSubjectOutcome;
  /** The declared provider profiles this bundle carries no matching anchor for. Present only on
   * `declared-but-absent`. */
  readonly declaredProfiles?: readonly string[];
}

export interface IntegrityAnchorsReport {
  /** One entry per carried record, in record-digest order. */
  readonly anchors: readonly AnchorVerificationEntry[];
  readonly subjects: readonly AnchorSubjectReport[];
  /** The subset the caller must refuse on. Empty means the check passes. */
  readonly invalid: readonly AnchorVerificationEntry[];
}

export interface EvaluateIntegrityAnchorsInput {
  readonly records: readonly CarriedAnchorRecord[];
  /** sha256 hex of the authenticated `run.json` bytes. */
  readonly runSha256: string;
  /** sha256 hex of the authenticated `matrix.json` bytes. */
  readonly matrixSha256: string;
  /** The sealed Run's own `closeAt`, for the §8 step-4 splice-catch. */
  readonly closeAt: string;
  /** Provider profiles the sealed Run's `anchor-intent/v1` extension declares (§7.3). */
  readonly declaredProfiles?: readonly string[];
  readonly trust?: PublicBundleAnchorTrustMaterial;
}

const SUBJECT_KINDS: ReadonlyMap<ClaimAnchorSubject, string> = new Map([
  ["lock", RUN_RECORD_KIND],
  ["matrix", MATRIX_RECORD_KIND],
]);

function compareCodeUnits(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidEntry(
  recordSha256: string,
  reason: string,
  extra: Partial<AnchorVerificationEntry> = {},
): AnchorVerificationEntry {
  return { recordSha256, status: "invalid", reason, trustMaterial: "none", ...extra };
}

export function evaluateIntegrityAnchors(input: EvaluateIntegrityAnchorsInput): IntegrityAnchorsReport {
  const subjectDigests: readonly (readonly [ClaimAnchorSubject, string])[] = [
    ["lock", input.runSha256],
    ["matrix", input.matrixSha256],
  ];
  const declared = input.declaredProfiles ?? [];

  const anchors = [...input.records]
    .sort((left, right) => compareCodeUnits(left.recordSha256, right.recordSha256))
    .map((carried): AnchorVerificationEntry => {
      // 1. Exact-bytes parse under the strict schema, and the sanctioned proof decoder.
      let record: ReturnType<typeof parseExactAnchorEvidence>;
      let proofBytes: Uint8Array;
      try {
        record = parseExactAnchorEvidence(carried.bytes);
        proofBytes = decodeAnchorProofContent(record.proof.content);
      } catch (cause) {
        return invalidEntry(
          carried.recordSha256,
          `not the exact sealed encoding of a conforming AnchorEvidence record: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      // 2. Recompute the subject from the authenticated snapshot, then check the kind label.
      const subjectDigest = record.subject.digest.sha256;
      const resolved = subjectDigests.find(([, digest]) => digest === subjectDigest);
      if (resolved === undefined) {
        return invalidEntry(
          carried.recordSha256,
          `the anchored digest ${subjectDigest} is neither this bundle's sealed Run nor its sealed Matrix`,
          { provider: record.provider },
        );
      }
      const [subject] = resolved;
      const resolvedKind = SUBJECT_KINDS.get(subject)!;
      if (record.subject.kind !== resolvedKind) {
        return invalidEntry(
          carried.recordSha256,
          `subject.kind is ${record.subject.kind}, but the record its digest resolves to is ${resolvedKind}`,
          { provider: record.provider, subject },
        );
      }

      // 3. Verify through the provider profile, with whatever material this reader configured.
      const rfc3161 = record.provider === RFC3161_TSA_ANCHOR_PROFILE;
      const openTimestamps = record.provider === OPENTIMESTAMPS_ANCHOR_PROFILE;
      if (!rfc3161 && !openTimestamps) {
        return invalidEntry(
          carried.recordSha256,
          `no proof verifier implements the anchor profile ${record.provider}`,
          { provider: record.provider, subject },
        );
      }
      const material = rfc3161 ? input.trust?.rfc3161 : input.trust?.opentimestamps;
      const result: AnchorProofResult = rfc3161
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
      const base = {
        recordSha256: carried.recordSha256,
        provider: record.provider,
        subject,
        trustMaterial,
      };
      if (result.status === "invalid") {
        return { ...base, status: "invalid", reason: result.reason };
      }
      if (result.status === "pending") {
        return { ...base, status: "pending", timeBasis: result.timeBasis, reason: result.reason };
      }
      // Exhaustive over the four proof statuses: `verified` and `present` are what remains, and the
      // rest of this walk reads the `facts` only they carry. A fifth member of ANCHOR_PROOF_STATUSES
      // fails here rather than arriving at the splice-catch as an unhandled shape.
      result.status satisfies "verified" | "present";

      // 4. The splice-catch, on `facts.genTime` so it survives the default no-roots configuration.
      if (subject === "lock" && result.timeBasis === "authority-time") {
        const genTime = (result.facts as { readonly genTime?: unknown }).genTime;
        const compared = typeof genTime === "string"
          ? compareCalendarStrictRfc3339Instants(genTime, input.closeAt)
          : undefined;
        if (compared === undefined || compared > 0) {
          return invalidEntry(
            carried.recordSha256,
            typeof genTime === "string"
              ? `the token's genTime ${genTime} is after this run's own pre-registered close instant ${input.closeAt}`
              : "an authority-time lock anchor carries no comparable genTime",
            { provider: record.provider, subject },
          );
        }
      }
      return {
        ...base,
        status: result.status,
        timeBasis: result.timeBasis,
        ...(result.status === "verified" ? { time: result.time } : {}),
        facts: result.facts,
      };
    });

  const subjects = subjectDigests.map(([subject]): AnchorSubjectReport => {
    const carried = anchors.filter((entry) => entry.subject === subject && entry.status !== "invalid");
    // §7.3: declared intent changes absence semantics. It is a fact the sealed Run states about
    // itself, so it is read against the lock subject; a matrix anchor is never declared in advance.
    const missing = subject === "lock"
      ? declared.filter((profile) => !carried.some((entry) => entry.provider === profile))
      : [];
    if (missing.length > 0) {
      return { subject, outcome: "declared-but-absent", declaredProfiles: [...missing].sort(compareCodeUnits) };
    }
    return { subject, outcome: carried.length > 0 ? "anchored" : "absent" };
  });

  return { anchors, subjects, invalid: anchors.filter((entry) => entry.status === "invalid") };
}
