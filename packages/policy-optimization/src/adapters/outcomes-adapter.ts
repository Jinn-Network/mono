// SPDX-License-Identifier: MIT

/**
 * The policy-outcomes adapter (product §8.2 item 2; substrate §6.3; program §1 C8).
 *
 * Same seven joins as the curation adapter (`./curation-adapter.ts`), plus three things
 * `@jinn-network/policy-outcomes`'s own README names as this package's obligation:
 *
 *   (a) TUPLE DERIVATION — `deriveExecutionTuple(task, submission, profile)` from
 *       `@jinn-network/policy-identity` (substrate §4.1). The caller supplies the three sealed
 *       documents alongside each announced verdict (`AnnouncedPolicyVerdict.task/.submission/
 *       .profile`); this adapter never invents a tuple, it only calls the frozen deriver and
 *       treats a `PolicyIdentityError` refusal as an adapter-level refusal, not an exception that
 *       escapes and drops the rest of the batch.
 *   (b) PER-AXIS FIDELITY STATUS — substrate §7's `match | mismatch | unverifiable` per axis,
 *       from whatever fidelity evidence the caller supplies (`AnnouncedPolicyVerdict.
 *       fidelityEvidence`, a narrow port). An axis with no supplied evidence defaults to the
 *       honest `"unverifiable"` — never silently upgraded, per substrate §7's rule that this is
 *       "the hardcoded posture of the only existing port implementation."
 *   (c) DEDUPE BY UNDERLYING VERDICT RECORD DIGEST — substrate §6.3: "the adapter contract
 *       dedupes on the underlying verdict record digest, not only on the announcement dedupe
 *       tuple." See the "Dedupe" section below for the key decision and the F-C2-2 disposition.
 *
 * `PolicyOutcomeObservation`/`PolicyOutcomeInputRef`/`PerAxisStatus` are imported directly from
 * `@jinn-network/policy-outcomes` (on this product's source-boundary allow-list, unlike
 * `packages/discovery`/`packages/marketplace`/`packages/task-supply` — see `./types.ts`'s module
 * doc), so this adapter's output is the real frozen type, not a mirror.
 *
 * ## Dedupe: the F-C2-2 disposition
 *
 * `@jinn-network/policy-outcomes`'s README (Findings F-C2-2) left open "whether `ref.record` is
 * guaranteed source-invariant for the same underlying verdict," and routed the question here,
 * to C8, with two options: confirm the facts-card derivation is a pure function of the
 * underlying on-chain fact (in which case `ref.record` alone is sufficient), or add a distinct
 * `verdictRecordDigest` field if it is not.
 *
 * Tracing the projector closes this for the two record roles these adapters read
 * (`packages/marketplace/projector/src/announce.ts`):
 *   - `anchorCheckedMaterial` REQUIRES, for both the `delivery` and `evaluation-delivery` roles,
 *     that `documentDigest(material.bytes)` equal the on-chain-anchored `expectedMaterialDigest`
 *     BEFORE the record is accepted into the announcement stream at all (a mismatch is refused
 *     as `announcement-material-refused`, never announced).
 *   - `record.digest` is then `writeRecord(...).digest`, which is `recordDigest(material.bytes)`
 *     (`packages/discovery/serve/src/layout.ts`) — a plain content hash of those SAME bytes.
 *   - `recordDigest` and `documentDigest` are the identical `sha256:${sha256Hex(bytes)}`
 *     computation (`packages/discovery/protocol/src/hashing.ts`,
 *     `packages/task-execution/protocol/src/hashing.ts`).
 *
 * So `record.digest` for these two roles is not merely probably deterministic, it is
 * cryptographically pinned to the on-chain anchor: any conformant source that announces a
 * delivery/evaluation-delivery record has already proven `record.digest` equals the anchored
 * digest, so two conformant sources observing the SAME on-chain event necessarily compute the
 * SAME `record.digest`. **F-C2-2 is closed for this adapter's scope**: `ref.record` alone is the
 * dedupe key substrate §6.3 asks for, no `verdictRecordDigest` extension needed. (A source that
 * skips the anchor check is a source-integrity problem outside this adapter's boundary — the
 * same "visible in the inputs, not preventable here" posture curation already documents for
 * Sybil verdicts.)
 *
 * That leaves the second half of substrate §6.3/F-C2-2, restated by program §1 C8's charter:
 * "two sources, different record digests for what claims to be the same verdict → BOTH kept +
 * flagged, because the adapter cannot know which is honest." Since `record.digest` is now known
 * to be source-invariant for a genuinely shared fact, two DIFFERING digests can only mean either
 * (i) they are honestly two distinct verdict events, or (ii) one side is non-conformant/corrupt —
 * and the adapter has no way to tell those apart. The signal used to notice the ambiguity at all
 * is `(attemptUri, attribution)`: the same evaluator delivering a verdict on the same attempt is
 * the natural "claims to be the same verdict" correlator available on this type (both are
 * required joins already). A group sharing `(attemptUri, attribution)` with more than one
 * distinct `record.digest` is flagged in `divergentRecordDigestGroups`; every observation in it
 * is still kept, per the disposition.
 */

import {
  deriveExecutionTuple,
  PolicyIdentityError,
  type AxisFidelityStatus,
  type ExecutionPolicyTuple,
  type ResolvedTaskProfile,
  type SealedSubmissionDoc,
  type SealedTaskDoc,
} from "@jinn-network/policy-identity";
import type {
  PerAxisStatus,
  PolicyOutcomeInputRef,
  PolicyOutcomeObservation,
} from "@jinn-network/policy-outcomes";
import {
  buildAdapterRef,
  resolveVerdictJoins,
  type AdapterRefusal,
  type AnnouncedVerdict,
  type Sha256Digest,
} from "./types.js";

export type { AdapterRefusal, AnnouncedVerdict } from "./types.js";

const UNVERIFIABLE: AxisFidelityStatus = "unverifiable";

/** Substrate §7's per-axis fidelity port: whatever evidence exists, honestly unverifiable otherwise. */
export interface PolicyFidelityEvidence {
  readonly harness?: AxisFidelityStatus;
  readonly model?: AxisFidelityStatus;
  readonly loadout?: AxisFidelityStatus;
  readonly isolationPolicy?: AxisFidelityStatus;
}

/**
 * `AnnouncedVerdict` plus the tuple-derivation inputs the caller resolves alongside each ref
 * (the sealed Task/Submission and the resolved profile the Task pins) and the optional
 * per-axis fidelity evidence.
 */
export interface AnnouncedPolicyVerdict extends AnnouncedVerdict {
  readonly task: SealedTaskDoc;
  readonly submission: SealedSubmissionDoc;
  readonly profile: ResolvedTaskProfile;
  readonly fidelityEvidence?: PolicyFidelityEvidence;
}

/** One group of observations that share `(attemptUri, attribution)` but disagree on `ref.record`. */
export interface DivergentRecordDigestGroup {
  readonly attemptUri: string;
  readonly attribution: string;
  readonly digests: readonly Sha256Digest[];
  readonly refs: readonly PolicyOutcomeInputRef[];
}

export interface OutcomesAdapterResult {
  readonly observations: readonly PolicyOutcomeObservation[];
  readonly refusals: readonly AdapterRefusal[];
  readonly divergentRecordDigestGroups: readonly DivergentRecordDigestGroup[];
}

function resolvePerAxisStatus(evidence: PolicyFidelityEvidence | undefined): PerAxisStatus {
  return {
    harness: evidence?.harness ?? UNVERIFIABLE,
    model: evidence?.model ?? UNVERIFIABLE,
    loadout: evidence?.loadout ?? UNVERIFIABLE,
    isolationPolicy: evidence?.isolationPolicy ?? UNVERIFIABLE,
  };
}

function refSortKey(ref: PolicyOutcomeInputRef): string {
  return [ref.source.agent, ref.source.name, ref.entry, ref.announcementId].join("");
}

function byRefOrder(a: PolicyOutcomeObservation, b: PolicyOutcomeObservation): number {
  const left = refSortKey(a.ref);
  const right = refSortKey(b.ref);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Joins each announced policy verdict into a `PolicyOutcomeObservation`: the shared five joins
 * (see `./types.ts`), tuple derivation, per-axis fidelity resolution, then the two-stage dedupe
 * documented in this module's header. Fail-closed and non-lossy throughout: every refusal names
 * every reason it failed for, and the divergent-digest case keeps both observations rather than
 * silently preferring one.
 */
export function deriveOutcomeObservations(
  records: readonly AnnouncedPolicyVerdict[],
): OutcomesAdapterResult {
  const candidates: PolicyOutcomeObservation[] = [];
  const refusals: AdapterRefusal[] = [];

  for (const record of records) {
    const joins = resolveVerdictJoins(record);
    if (!joins.ok) {
      refusals.push({ reasons: joins.reasons, provenance: record.provenance });
      continue;
    }

    let tuple: ExecutionPolicyTuple;
    try {
      tuple = deriveExecutionTuple(record.task, record.submission, record.profile);
    } catch (cause) {
      const detail = cause instanceof PolicyIdentityError ? cause.message : String(cause);
      refusals.push({
        reasons: [{ kind: "tuple-derivation-refused", detail }],
        provenance: record.provenance,
      });
      continue;
    }

    candidates.push({
      tuple,
      perAxisStatus: resolvePerAxisStatus(record.fidelityEvidence),
      taskDigest: joins.value.taskDigest,
      verdict: joins.value.verdict,
      observedAt: record.entryTimestamp,
      attribution: joins.value.attribution,
      ...(record.benchmarkRun === undefined ? {} : { benchmarkRun: record.benchmarkRun }),
      ref: buildAdapterRef(record),
    });
  }

  // Stage 1: dedupe by `ref.record` (the underlying verdict record digest, F-C2-2 closed — see
  // module header). Every candidate sharing one digest is the SAME underlying verdict, however
  // many sources announced it; collapse to one observation, chosen deterministically so the
  // result does not depend on input order.
  const byDigest = new Map<Sha256Digest, PolicyOutcomeObservation[]>();
  for (const candidate of candidates) {
    const bucket = byDigest.get(candidate.ref.record);
    if (bucket === undefined) byDigest.set(candidate.ref.record, [candidate]);
    else bucket.push(candidate);
  }
  const deduped = [...byDigest.values()].map(
    (group) => [...group].sort(byRefOrder)[0]!,
  );

  // Stage 2: flag `(attemptUri, attribution)` groups that, after digest-dedupe, still disagree on
  // `ref.record` — two sources claiming the same verdict with genuinely different record content.
  // The adapter cannot know which is honest, so every observation in the group is kept.
  const byClaim = new Map<string, PolicyOutcomeObservation[]>();
  for (const observation of deduped) {
    const key = `${observation.ref.attemptUri}${observation.attribution}`;
    const bucket = byClaim.get(key);
    if (bucket === undefined) byClaim.set(key, [observation]);
    else bucket.push(observation);
  }

  const divergentRecordDigestGroups: DivergentRecordDigestGroup[] = [];
  for (const group of byClaim.values()) {
    const digests = [...new Set(group.map((observation) => observation.ref.record))];
    if (digests.length <= 1) continue;
    const [{ ref: { attemptUri }, attribution }] = group;
    divergentRecordDigestGroups.push({
      attemptUri,
      attribution,
      digests,
      refs: group.map((observation) => observation.ref).sort((a, b) =>
        refSortKey(a) < refSortKey(b) ? -1 : refSortKey(a) > refSortKey(b) ? 1 : 0,
      ),
    });
  }

  return {
    observations: deduped.sort(byRefOrder),
    refusals,
    divergentRecordDigestGroups: divergentRecordDigestGroups.sort((a, b) =>
      a.attemptUri === b.attemptUri
        ? (a.attribution < b.attribution ? -1 : a.attribution > b.attribution ? 1 : 0)
        : (a.attemptUri < b.attemptUri ? -1 : 1),
    ),
  };
}
