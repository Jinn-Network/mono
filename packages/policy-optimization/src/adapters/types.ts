// SPDX-License-Identifier: MIT

/**
 * Shared adapter primitives (product design §8.2; substrate §6.3).
 *
 * Both observation adapters — curation (`curation-adapter.ts`) and policy-outcomes
 * (`outcomes-adapter.ts`) — consume the SAME seven upstream joins, documented in
 * `@jinn-network/task-curation`'s README "Adapter boundary" table:
 *
 *   1. subject task digest  — the evaluation Task payload's `subjectTask.digest`
 *      (`packages/marketplace/binding/src/evaluation-derive.ts`, which embeds it verbatim in
 *      `deriveEvaluationTask`'s output `payload.subjectTask`) OR the Result Evaluation
 *      Statement's `subject`/`predicate.taskSubject` resolution
 *      (`packages/task-execution/profiles/src/result-evaluation.ts`) — TWO independent sources.
 *   2. statementVerdict      — the verdict-correspondence facts card
 *      (`packages/marketplace/projector/src/announce.ts`,
 *      `"https://jinn.network/facts/marketplace-verdict-correspondence/1.0"`).
 *   3. observedAt            — `AnnouncementEntry.timestamp`
 *      (`packages/discovery/protocol/src/entry.ts`), block time, never adapter wall-clock.
 *   4. attribution           — on-chain `VerdictDeliveryClaimed.evaluator`
 *      (`packages/marketplace/projector/src/events.ts`) OR the Result Evaluation Statement
 *      predicate's `evaluator.id` — TWO independent sources.
 *   5. benchmarkRun          — the JUDGED SOLUTION Delivery's `benchrun` facts-card attribute
 *      (`packages/discovery/facts/task-execution/profiles/delivery.1.0.json`); absent means
 *      organic.
 *   6. ref (provenance)      — `AnnouncedItem.provenance` (`packages/discovery/protocol/src/
 *      item.ts`) plus `record.digest`.
 *   7. attemptUri            — the (evaluation-delivery) Delivery facts card's own `attemptUri`.
 *
 * This product does not import `packages/discovery`, `packages/marketplace`, or
 * `packages/task-supply` — the product's own source-boundary guard
 * (`.github/scripts/policy-optimization-source-boundaries.test.mjs`) denies all three, because
 * v0 "consumes the marketplace read-only through the §8.2 adapters' injected ports" (design
 * §11). Every shape below is therefore MIRRORED field-for-field, never imported, exactly as
 * `@jinn-network/task-curation` and `@jinn-network/policy-outcomes` themselves mirror
 * `AnnouncedItem`/`CurationInputRef` rather than import discovery/marketplace types (their own
 * `observation.ts` files document the same choice). The adapter performs no fetch itself: the
 * caller's discovery-read port resolves every field below and hands over already-typed records
 * — "product code with injected ports" (design §8.2).
 */

export type Sha256Digest = `sha256:${string}`;

/** RFC 3339 instant. In practice `AnnouncementEntry.timestamp` — never adapter wall-clock. */
export type Instant = string;

export type ObservedVerdict = "pass" | "fail" | "inconclusive";

/** Mirrors `packages/discovery/protocol/src/item.ts`'s `SourceIdentity`. */
export interface MirroredSourceIdentity {
  readonly agent: string;
  readonly name: string;
}

/** Mirrors `AnnouncedItem.provenance` (`packages/discovery/protocol/src/item.ts`). */
export interface MirroredProvenance {
  readonly source: MirroredSourceIdentity;
  readonly entry: Sha256Digest;
  readonly announcementId: string;
}

/** Mirrors `AnnouncedItem.record` (kind + content digest). */
export interface MirroredRecordRef {
  readonly kind: string;
  readonly digest: Sha256Digest;
}

/**
 * The ref shape both `CurationInputRef` (`@jinn-network/task-curation`) and
 * `PolicyOutcomeInputRef` (`@jinn-network/policy-outcomes`) already use, field for field
 * (substrate §6.1: "dedupe tuple identical to curation's"). Built once here so both adapters
 * assemble a structurally identical ref from the same joined record.
 */
export interface AdapterInputRef {
  readonly source: MirroredSourceIdentity;
  readonly entry: Sha256Digest;
  readonly announcementId: string;
  readonly record: Sha256Digest;
  readonly attemptUri: string;
}

/**
 * One announced verdict, joined by the caller's discovery-read port up to the boundary these
 * adapters need. Two of the seven joins (subject task digest, attribution) name TWO independent
 * upstream candidate sources in the curation README; both candidates ride on this type so the
 * adapter can compare them and fail closed on disagreement rather than silently preferring one.
 */
export interface AnnouncedVerdict {
  /** The evaluation-delivery `AnnouncedItem.record`. */
  readonly record: MirroredRecordRef;
  /** The evaluation-delivery `AnnouncedItem.provenance`. */
  readonly provenance: MirroredProvenance;
  /** `AnnouncementEntry.timestamp` — the entry that carried this announcement. */
  readonly entryTimestamp: Instant;
  /** The evaluation-delivery's OWN delivery facts-card `attemptUri` (join 7). */
  readonly attemptUri: string;
  /** The verdict-correspondence facts card's `statementVerdict` (join 2). Absent ⇒ refuse. */
  readonly statementVerdict?: ObservedVerdict;
  /** Subject task digest, candidate A: the evaluation Task payload's `subjectTask.digest`. */
  readonly subjectTaskDigestFromEvaluationTask?: Sha256Digest;
  /** Subject task digest, candidate B: the Result Evaluation Statement's subject resolution. */
  readonly subjectTaskDigestFromStatementSubjects?: Sha256Digest;
  /** Attribution, candidate A: the on-chain `VerdictDeliveryClaimed.evaluator`. */
  readonly attributionFromChainEvent?: string;
  /** Attribution, candidate B: the Result Evaluation Statement predicate's `evaluator.id`. */
  readonly attributionFromStatementPredicate?: string;
  /** The judged-solution Delivery facts card's `benchrun`; absent ⇒ organic. */
  readonly benchmarkRun?: string;
}

export type AdapterRefusalReason =
  | { readonly kind: "missing-subject-task-digest" }
  | {
      readonly kind: "conflicting-subject-task-digest";
      readonly candidates: readonly [Sha256Digest, Sha256Digest];
    }
  | { readonly kind: "missing-verdict" }
  | { readonly kind: "missing-attribution" }
  | {
      readonly kind: "conflicting-attribution";
      readonly candidates: readonly [string, string];
    }
  | { readonly kind: "tuple-derivation-refused"; readonly detail: string };

/**
 * One refused announcement, with every reason it was refused (a record can fail more than one
 * join at once — e.g. a missing verdict AND a missing attribution). Never silently dropped:
 * both adapters return refusals alongside observations, never in place of them.
 */
export interface AdapterRefusal {
  readonly reasons: readonly AdapterRefusalReason[];
  readonly provenance: MirroredProvenance;
}

interface CandidateAgreement<T> {
  readonly ok: true;
  readonly value: T;
}

interface CandidateMissing {
  readonly ok: false;
  readonly reason: "missing";
}

interface CandidateConflict<T> {
  readonly ok: false;
  readonly reason: "conflict";
  readonly candidates: readonly [T, T];
}

type CandidateResolution<T> = CandidateAgreement<T> | CandidateMissing | CandidateConflict<T>;

/**
 * Resolves a join with up to two independent candidate sources: absent ⇒ missing, both present
 * and equal ⇒ that value, both present and unequal ⇒ conflict. Exactly one present is not a
 * conflict — a single honestly-resolved source is sufficient.
 */
function resolveCandidate<T>(a: T | undefined, b: T | undefined): CandidateResolution<T> {
  if (a === undefined && b === undefined) return { ok: false, reason: "missing" };
  if (a === undefined) return { ok: true, value: b as T };
  if (b === undefined) return { ok: true, value: a };
  if (a === b) return { ok: true, value: a };
  return { ok: false, reason: "conflict", candidates: [a, b] };
}

export interface ResolvedVerdictJoins {
  readonly taskDigest: Sha256Digest;
  readonly verdict: ObservedVerdict;
  readonly attribution: string;
}

export type VerdictJoinResolution =
  | { readonly ok: true; readonly value: ResolvedVerdictJoins }
  | { readonly ok: false; readonly reasons: readonly AdapterRefusalReason[] };

/**
 * The five joins both adapters share (taskDigest, verdict, attribution — `observedAt`,
 * `benchmarkRun`, and `ref` pass through directly with no candidate resolution). Fail-closed:
 * every disagreeing or missing join is collected, not just the first, so a refusal names every
 * reason at once.
 */
export function resolveVerdictJoins(record: AnnouncedVerdict): VerdictJoinResolution {
  const reasons: AdapterRefusalReason[] = [];

  const taskDigest = resolveCandidate(
    record.subjectTaskDigestFromEvaluationTask,
    record.subjectTaskDigestFromStatementSubjects,
  );
  if (!taskDigest.ok) {
    reasons.push(
      taskDigest.reason === "missing"
        ? { kind: "missing-subject-task-digest" }
        : { kind: "conflicting-subject-task-digest", candidates: taskDigest.candidates },
    );
  }

  if (record.statementVerdict === undefined) {
    reasons.push({ kind: "missing-verdict" });
  }

  const attribution = resolveCandidate(
    record.attributionFromChainEvent,
    record.attributionFromStatementPredicate,
  );
  if (!attribution.ok) {
    reasons.push(
      attribution.reason === "missing"
        ? { kind: "missing-attribution" }
        : { kind: "conflicting-attribution", candidates: attribution.candidates },
    );
  }

  if (reasons.length > 0 || !taskDigest.ok || !attribution.ok || record.statementVerdict === undefined) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    value: {
      taskDigest: taskDigest.value,
      verdict: record.statementVerdict,
      attribution: attribution.value,
    },
  };
}

/** Assembles the ref both adapters share, from one joined record. */
export function buildAdapterRef(record: AnnouncedVerdict): AdapterInputRef {
  return {
    source: record.provenance.source,
    entry: record.provenance.entry,
    announcementId: record.provenance.announcementId,
    record: record.record.digest,
    attemptUri: record.attemptUri,
  };
}
