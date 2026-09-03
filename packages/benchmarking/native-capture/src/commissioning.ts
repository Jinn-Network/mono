// SPDX-License-Identifier: Apache-2.0

/**
 * Commissioning dual-write and explicit backfill (issue #3339, amendment §10 stack 10).
 *
 * An `ExecutionCommissioningLink` records that a native execution was commissioned through some
 * external protocol. It is a *separate* record: an Execution Evidence record has the same exact
 * bytes whether or not a link is later added (amendment §1), and every path here re-reads the
 * evidence after writing the link to prove that, rather than asserting it only in a test.
 *
 * Every lineage field is a protocol-neutral reference, so this package still imports no TEP. The
 * caller -- a commissioning adapter that may depend on both TEP and this package -- supplies the
 * already-sealed submission and delivery references.
 */

import {
  BENCHMARKING_PROTOCOL_V2,
  EXECUTION_COMMISSIONING_LINK_RECORD_KIND,
  sealExecutionCommissioningLink,
  type DigestBearingResourceDescriptor,
  type EvidenceRecordReference,
  type SealedRecord,
  type TypedRecordReference,
} from "@jinn-network/benchmarking-protocol";
import { recordDigest } from "@jinn-network/evidence-protocol";

import { NativeCaptureError } from "./errors.js";
import type { CaptureClock, NativeCaptureStore } from "./types.js";

/**
 * The commissioning lineage of one captured unit. `attempts` and `deliveries` are plural because a
 * commissioned call may be retried; the link schema requires both sorted and unique.
 */
export interface NativeCommissioningLineage {
  readonly publisher: string;
  readonly submission: TypedRecordReference;
  readonly attempts: readonly string[];
  readonly deliveries: readonly TypedRecordReference[];
  readonly observations?: DigestBearingResourceDescriptor;
  readonly accounting?: TypedRecordReference;
}

export interface WrittenCommissioningLink {
  readonly unitKey: string;
  readonly execution: EvidenceRecordReference;
  readonly link: SealedRecord;
  readonly reference: TypedRecordReference;
}

function sortedUnique<T>(values: readonly T[], key: (value: T) => string, what: string): T[] {
  const sorted = [...values].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
  if (sorted.some((value, index) => index > 0 && key(sorted[index - 1]!) === key(value))) {
    throw new NativeCaptureError("CAPTURE_NONCONFORMING", `commissioning ${what} contain a duplicate`);
  }
  return sorted;
}

function typedKey(reference: TypedRecordReference): string {
  return `${reference.recordKind} ${reference.record.digest.sha256}`;
}

/**
 * Seals one commissioning link over an already-stored execution-evidence record, writes it to the
 * store, then re-resolves the evidence to prove the write moved no evidence byte.
 *
 * Shared by the coordinator's dual-write and by `backfillExecutionCommissioningLinks`; the only
 * difference between those two is when it is called, which is why they share a body.
 */
export function writeExecutionCommissioningLink(input: {
  readonly store: NativeCaptureStore;
  readonly clock: CaptureClock;
  readonly unitKey: string;
  readonly execution: EvidenceRecordReference;
  readonly lineage: NativeCommissioningLineage;
}): WrittenCommissioningLink {
  const { store, clock, unitKey, execution, lineage } = input;

  const before = store.resolveEvidence(execution);
  const beforeDigest = recordDigest(before);
  if (beforeDigest.slice(7) !== execution.record.digest.sha256) {
    throw new NativeCaptureError(
      "CAPTURE_NONCONFORMING",
      `${unitKey}: execution evidence digest mismatch before commissioning`,
    );
  }

  const link = sealExecutionCommissioningLink({
    protocol: BENCHMARKING_PROTOCOL_V2,
    execution,
    submission: lineage.submission,
    attempts: sortedUnique(lineage.attempts, (value) => value, "attempts"),
    deliveries: sortedUnique(lineage.deliveries, typedKey, "deliveries"),
    ...(lineage.observations === undefined ? {} : { observations: lineage.observations }),
    ...(lineage.accounting === undefined ? {} : { accounting: lineage.accounting }),
    publisher: lineage.publisher,
    linkedAt: clock.now(),
  });
  const reference = store.putRecord(
    EXECUTION_COMMISSIONING_LINK_RECORD_KIND,
    `${unitKey}.commissioning-link.json`,
    link,
  );

  if (recordDigest(store.resolveEvidence(execution)) !== beforeDigest) {
    throw new NativeCaptureError(
      "CAPTURE_NONCONFORMING",
      `${unitKey}: writing a commissioning link changed the execution evidence bytes`,
    );
  }

  return { unitKey, execution, link, reference };
}

/** The shape `backfillExecutionCommissioningLinks` reads out of a completed capture record. */
export interface CommissionableCapture {
  readonly units: readonly {
    readonly unitKey: string;
    readonly executionEvidence?: EvidenceRecordReference;
  }[];
}

/**
 * Attaches commissioning links to the already-sealed evidence of a completed capture.
 *
 * This is the explicit, after-the-fact half of stack 10: the dual-write covers runs commissioned
 * as they happen, this covers evidence that was already sealed when its lineage became known. It
 * mutates nothing -- not the evidence, not the capture record -- and refuses a unit key it cannot
 * account for rather than skipping it, because a silently skipped unit leaves an evidence record
 * that looks uncommissioned and is not.
 */
export function backfillExecutionCommissioningLinks(input: {
  readonly store: NativeCaptureStore;
  readonly clock: CaptureClock;
  readonly capture: CommissionableCapture;
  readonly lineage: ReadonlyMap<string, NativeCommissioningLineage>;
}): readonly WrittenCommissioningLink[] {
  const { store, clock, capture, lineage } = input;
  const captured = new Map(
    capture.units.flatMap((unit) =>
      unit.executionEvidence === undefined ? [] : [[unit.unitKey, unit.executionEvidence] as const],
    ),
  );
  return [...lineage.keys()].sort().map((unitKey) => {
    const execution = captured.get(unitKey);
    if (execution === undefined) {
      throw new NativeCaptureError(
        "ATOM_COORDINATE_MISMATCH",
        `commissioning backfill names ${unitKey}, which the capture does not carry as a captured unit`,
      );
    }
    return writeExecutionCommissioningLink({
      store,
      clock,
      unitKey,
      execution,
      lineage: lineage.get(unitKey)!,
    });
  });
}
