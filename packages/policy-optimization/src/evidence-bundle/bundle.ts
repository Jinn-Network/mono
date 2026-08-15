// SPDX-License-Identifier: MIT

/**
 * The frozen evidence bundle a proposer consumes (substrate §5.1's `evidenceProvenance`; product
 * design §7.1's `evidence` argument; program ruling R5).
 *
 * A bundle is three things fused into one content-addressed document: **which query** produced it
 * (the saved-query digest), **what the sources looked like when it ran** (the `QuerySnapshotReceipt`),
 * and **exactly which records, in exactly which order** were handed over. Digests only — substrate
 * §5.1: "No query text and no record content ever crosses the operator boundary inside a manifest."
 *
 * ## Why the exclusion runs here and not upstream
 *
 * Ruling R5 says the filter is wired into bundle assembly and "a passthrough is a blocker by
 * definition". A filter that only exists as a helper the caller *may* call is a passthrough: the
 * one code path that produces the `evidenceProvenance` a manifest is admitted on would still accept
 * an unfiltered list. So assembly does not filter — it **refuses**. `partitionHeldOut` is exported
 * for the caller that wants to drop excluded records at the query layer, and assembly independently
 * re-checks and fails closed. The refusal, not the helper, is the control.
 *
 * The consequence is intentional: there is no way to obtain a `CandidateEvidenceProvenance` from
 * this package without naming a boundary. C6's learner refuses to seal a manifest without
 * provenance (FINDING F-C6-1), so the two refusals compose into "no candidate exists that was not
 * proposed against a declared held-out boundary".
 */

import {
  canonicalJsonBytes,
  prefixedDigest,
  type CandidateEvidenceProvenance,
  type QuerySnapshotReceiptMirror,
} from "@jinn-network/policy-identity";
import { issue, refuse, refuseAll, type PolicyOptimizationIssue } from "../errors.js";
import { EVIDENCE_BUNDLE_FORMAT_TOKEN } from "../tokens.js";
import type { JsonValue } from "../types.js";
import {
  assertValidBoundary,
  assertValidRecordRefs,
  heldOutBoundaryDigest,
  partitionHeldOut,
  type EvidenceRecordRef,
  type HeldOutBoundary,
} from "./held-out.js";

/**
 * The bundle manifest. Content-addressed by its own canonical bytes.
 *
 * `heldOutBoundary` carries the boundary's *digest and source reference*, never its items: the
 * items are the secret a committed Benchmark exists to keep (§6.3), and a bundle manifest is the
 * document most likely to be handed to a proposer.
 */
export interface EvidenceBundleManifest {
  readonly formatToken: string;
  readonly savedQueryDigest: string;
  readonly snapshotReceipt: QuerySnapshotReceiptMirror;
  readonly heldOutBoundary: {
    readonly kind: "benchmark" | "slate";
    readonly ref: string;
    readonly digest: string;
  };
  /** The exact ordered record-reference list actually supplied. Order is the query's, preserved. */
  readonly records: readonly EvidenceRecordRef[];
  /** `sha256:` over the canonical bytes of `records` — substrate §5.1's third provenance member. */
  readonly recordListDigest: string;
}

export interface AssembledEvidenceBundle {
  readonly bundle: EvidenceBundleManifest;
  readonly bytes: Uint8Array;
  /** `sha256:` over `bytes` — the reference a proposal request and a journal entry carry. */
  readonly digest: string;
  /**
   * The substrate §5.1 block, ready to drop into a `CandidateManifest`. This is the value C6's
   * candidate mode is blocked on (FINDING F-C6-1).
   */
  readonly provenance: CandidateEvidenceProvenance;
}

export interface AssembleEvidenceBundleInput {
  readonly savedQueryDigest: string;
  readonly snapshotReceipt: QuerySnapshotReceiptMirror;
  /** The ordered records the query returned. Assembly refuses if any is inside the boundary. */
  readonly records: readonly EvidenceRecordRef[];
  readonly boundary: HeldOutBoundary;
}

const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;

/**
 * `sha256:` over the canonical bytes of the ordered record-reference list.
 *
 * The list is **not** sorted first. Substrate §5.1 says "a digest over the exact ordered
 * record-reference list actually supplied": order is part of what the proposer consumed — a
 * retrieval's ranking is evidence about relevance, and two orderings of one record set are two
 * different inputs. Sorting here would make the digest agree across bundles that were not the same
 * bundle.
 */
export function recordListDigest(records: readonly EvidenceRecordRef[]): string {
  return prefixedDigest(canonicalJsonBytes(records.map(normalizeRecord) as unknown as JsonValue));
}

/**
 * Members in a fixed order with `undefined` dropped, so a caller that spells an absent `repo` as
 * `{repo: undefined}` and one that omits it produce the same digest. `canonicalJsonBytes` already
 * orders keys; this exists for the omitted-versus-explicitly-undefined case.
 */
function normalizeRecord(record: EvidenceRecordRef): Record<string, string> {
  return {
    record: record.record,
    ...(record.instanceId === undefined ? {} : { instanceId: record.instanceId }),
    ...(record.repo === undefined ? {} : { repo: record.repo }),
  };
}

function checkReceipt(receipt: unknown, savedQueryDigest: string): readonly PolicyOptimizationIssue[] {
  const errors: PolicyOptimizationIssue[] = [];
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    return [issue("invalid-document", "snapshotReceipt", "snapshotReceipt must be a JSON object")];
  }
  const value = receipt as Record<string, unknown>;
  if (typeof value["savedQueryDigest"] !== "string" || !SHA256_PREFIXED.test(value["savedQueryDigest"])) {
    errors.push(issue("invalid-document", "snapshotReceipt.savedQueryDigest",
      "savedQueryDigest must be sha256:<64 lowercase hex>"));
  } else if (value["savedQueryDigest"] !== savedQueryDigest) {
    // The same check `validateCandidateManifest` runs, run one layer earlier: a receipt naming a
    // different query is a clean, replayable receipt attached to a bundle assembled from a dirtier
    // one, and catching it at assembly means no such bundle ever acquires a digest.
    errors.push(issue("invalid-document", "snapshotReceipt.savedQueryDigest",
      "the snapshot receipt names a different saved query than the bundle"));
  }
  if (typeof value["sourceSet"] !== "object" || value["sourceSet"] === null) {
    errors.push(issue("invalid-document", "snapshotReceipt.sourceSet",
      "the snapshot receipt must name its source set"));
  }
  if (!Array.isArray(value["sources"])) {
    errors.push(issue("invalid-document", "snapshotReceipt.sources",
      "the snapshot receipt must carry a per-source checkpoint list"));
  }
  if (typeof value["evaluatedAt"] !== "string" || value["evaluatedAt"] === "") {
    errors.push(issue("invalid-document", "snapshotReceipt.evaluatedAt",
      "the snapshot receipt must carry the instant it was evaluated"));
  }
  if (value["reproducibility"] !== "replayable" && value["reproducibility"] !== "not-replayable") {
    errors.push(issue("invalid-document", "snapshotReceipt.reproducibility",
      'reproducibility must be "replayable" or "not-replayable"'));
  }
  return errors;
}

/**
 * Assembles the bundle, refusing rather than filtering (see the module header).
 *
 * An empty record list is legal and sealed as such: a query that matched nothing is a real,
 * honestly-reportable input, and a proposer that received nothing should be able to say so with a
 * provenance block rather than with an absence.
 */
export function assembleEvidenceBundle(
  input: AssembleEvidenceBundleInput,
): AssembledEvidenceBundle {
  if (typeof input.savedQueryDigest !== "string" || !SHA256_PREFIXED.test(input.savedQueryDigest)) {
    refuse("invalid-document", "savedQueryDigest", "savedQueryDigest must be sha256:<64 lowercase hex>");
  }
  assertValidBoundary(input.boundary, "boundary");
  assertValidRecordRefs(input.records, "records");

  const receiptErrors = checkReceipt(input.snapshotReceipt, input.savedQueryDigest);
  if (receiptErrors.length > 0) refuseAll(receiptErrors);

  const { excluded } = partitionHeldOut(input.records, input.boundary);
  if (excluded.length > 0) {
    refuseAll(excluded.map((hit) => issue("held-out-contamination", "records",
      hit.axis === "unattributable"
        ? `record ${hit.record} carries neither an instance id nor a repo, so nothing establishes it is outside the held-out boundary`
        : `record ${hit.record} is inside the held-out boundary on ${hit.axis} ${hit.value}`)));
  }

  const records = input.records.map(normalizeRecord) as unknown as readonly EvidenceRecordRef[];
  const bundle: EvidenceBundleManifest = {
    formatToken: EVIDENCE_BUNDLE_FORMAT_TOKEN,
    savedQueryDigest: input.savedQueryDigest,
    snapshotReceipt: input.snapshotReceipt,
    heldOutBoundary: {
      kind: input.boundary.source.kind,
      ref: input.boundary.source.ref,
      digest: heldOutBoundaryDigest(input.boundary),
    },
    records,
    recordListDigest: recordListDigest(records),
  };

  const bytes = canonicalJsonBytes(bundle as unknown as JsonValue);
  return {
    bundle,
    bytes,
    digest: prefixedDigest(bytes),
    provenance: {
      savedQueryDigest: bundle.savedQueryDigest,
      snapshotReceipt: bundle.snapshotReceipt,
      recordListDigest: bundle.recordListDigest,
    },
  };
}

/**
 * Does a manifest's `evidenceProvenance` name exactly this bundle?
 *
 * Compared member-by-member on canonical bytes rather than on the `recordListDigest` alone. The
 * record-list digest is the member a proposer could copy from an honest bundle onto a manifest
 * whose receipt says something else, and admission's whole reason to hold the issued bundle is to
 * refuse that.
 */
export function provenanceMatchesBundle(
  provenance: CandidateEvidenceProvenance,
  bundle: EvidenceBundleManifest,
): boolean {
  if (provenance.savedQueryDigest !== bundle.savedQueryDigest) return false;
  if (provenance.recordListDigest !== bundle.recordListDigest) return false;
  const left = canonicalJsonBytes(provenance.snapshotReceipt as unknown as JsonValue);
  const right = canonicalJsonBytes(bundle.snapshotReceipt as unknown as JsonValue);
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}
