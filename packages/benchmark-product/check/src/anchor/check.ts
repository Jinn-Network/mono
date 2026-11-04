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
 * The walk is `evaluateAnchors` from `@jinn-network/verify`. This file gives it the bundle's two
 * subjects, the wording a claim carries, and the splice-catch.
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
import { evaluateAnchors } from "@jinn-network/verify";
import type {
  AnchorProofContext,
  AnchorRefusal,
  AnchorSubjectReport as RecordAnchorSubjectReport,
  AnchorTrustMaterial,
  AnchorVerificationEntry as RecordAnchorVerificationEntry,
  AnchorsReport,
} from "@jinn-network/verify";
import type { CarriedAnchorRecord, ClaimAnchorSubject } from "../profile/anchor-claims.js";

export type { AnchorProofStatus } from "@jinn-network/verify";

/**
 * Verifier-side trust material, keyed by provider profile. Strictly the verifier operator's own
 * configuration: this package ships none, and an empty set can never yield `verified` (§8 step 3).
 */
export type PublicBundleAnchorTrustMaterial = AnchorTrustMaterial;

/** §7.3's absence semantics, plus the positive case. */
export type AnchorSubjectOutcome = RecordAnchorSubjectReport["outcome"];

export type AnchorVerificationEntry = RecordAnchorVerificationEntry<ClaimAnchorSubject>;

export type AnchorSubjectReport = RecordAnchorSubjectReport<ClaimAnchorSubject>;

export type IntegrityAnchorsReport = AnchorsReport<ClaimAnchorSubject>;

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

/** Plain nouns keep a human refusal intelligible after its declared protocol kind is aliased. */
const SUBJECT_NAMES: Readonly<Record<ClaimAnchorSubject, string>> = { lock: "Run", matrix: "Matrix" };

function bundleRefusalReason(refusal: AnchorRefusal<ClaimAnchorSubject>): string | undefined {
  switch (refusal.code) {
    case "unknown-subject":
      return `the anchored digest ${refusal.digest} is neither this bundle's sealed Run nor its sealed Matrix`;
    case "subject-kind-mismatch":
      return `subject.kind is ${refusal.kind}, but its digest resolves to this bundle's sealed ${SUBJECT_NAMES[refusal.subject]}`;
    default:
      return undefined;
  }
}

/** The splice-catch, on `facts.genTime` so it survives the default no-roots configuration. */
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

export function evaluateIntegrityAnchors(input: EvaluateIntegrityAnchorsInput): IntegrityAnchorsReport {
  return evaluateAnchors<ClaimAnchorSubject>({
    records: input.records,
    subjects: [
      {
        id: "lock",
        sha256: input.runSha256,
        kind: RUN_RECORD_KIND,
        // §7.3: declared intent changes absence semantics. It is a fact the sealed Run states about
        // itself, so it is read against the lock subject; a matrix anchor is never declared in advance.
        ...(input.declaredProfiles === undefined ? {} : { declaredProfiles: input.declaredProfiles }),
      },
      { id: "matrix", sha256: input.matrixSha256, kind: MATRIX_RECORD_KIND },
    ],
    ...(input.trust === undefined ? {} : { trust: input.trust }),
    renderReason: bundleRefusalReason,
    rejectProof: spliceCatch(input.closeAt),
  });
}
