// SPDX-License-Identifier: MIT

/**
 * The wave engine's journal payloads (product design §5.2, §6.2).
 *
 * C7a deliberately left `payload` unschematized — "per-event payload schemas belong to the
 * sub-unit that emits them". These are that sub-unit's, and they are built by functions rather
 * than by call sites so the shape of a `run-sealed` entry is one decision recorded once.
 *
 * Every payload obeys the same rule: **references, never content.** A payload names digests, counts,
 * and the decision the product made; the authoritative facts stay in the sealed records those
 * digests address. The journal is "the non-derivable ordering of product decisions" (§5.2) — a
 * payload that inlined a Matrix would be a second, unsigned copy of a record that already exists.
 *
 * The one payload that carries more than references is `allocation-decided`, and §6.2 requires
 * exactly that: "Every pruning decision is journaled with the rows and Reports it consumed, so
 * survivorship is post-hoc auditable." Its `inputs` block is the audit trail; without it a pruned
 * candidate's disappearance is unexplainable after the fact.
 */

import type { MatrixRecord, ReportRecord } from "@jinn-network/benchmarking-records";
import type { CampaignJournalEntryInput, CampaignJournalEventType } from "./journal-entry.js";
import { appendCampaignEvent, type AppendOptions, type CampaignHandle } from "./journal-store.js";
import type { JsonValue } from "./types.js";
import type { AllocationDecision, WavePlan } from "./wave-types.js";

type Payload = Readonly<Record<string, JsonValue>>;

function armEntries(plan: WavePlan): JsonValue {
  return plan.arms.map((arm) => ({
    armId: arm.armId,
    tupleDigest: arm.tupleDigest,
    source: { kind: arm.source.kind, digest: arm.source.digest },
  }));
}

/** §5.2 `wave-planned` — the wave boundary itself: what this wave is, before it is sealed. */
export function wavePlannedPayload(plan: WavePlan): Payload {
  return {
    wave: plan.waveNumber,
    kind: plan.kind,
    benchmark: plan.benchmark.digest,
    ...(plan.benchmark.derivedFrom === undefined
      ? {}
      : { benchmarkDerivedFrom: plan.benchmark.derivedFrom }),
    tasks: plan.benchmark.record.items.length,
    replicates: plan.run.record.replicates,
    arms: armEntries(plan),
    cells: plan.cells,
  };
}

/** §5.2 `run-sealed` — the Run exists and the campaign has committed its cells to the budget. */
export function runSealedPayload(plan: WavePlan): Payload {
  return {
    wave: plan.waveNumber,
    kind: plan.kind,
    run: plan.run.digest,
    benchmark: plan.benchmark.digest,
    cells: plan.cells,
  };
}

/**
 * §5.2 `promotion-run-sealed` — the same facts plus the reveal, because the reveal is the thing
 * that makes this Run the gate rather than another wave.
 */
export function promotionRunSealedPayload(
  plan: WavePlan,
  admission: { readonly revealedItems: number; readonly committedItems: number },
): Payload {
  return {
    ...runSealedPayload(plan),
    revealedItems: admission.revealedItems,
    committedItems: admission.committedItems,
    preregisteredMethods: (plan.run.record.analysisPlan ?? []).map((entry) => ({
      method: entry.method,
      version: entry.version,
    })),
  };
}

/** §6.2 `allocation-decided` — the decision, and everything it read. */
export function allocationDecidedPayload(decision: AllocationDecision): Payload {
  return {
    wave: decision.waveNumber,
    policyRef: decision.policyRef,
    retained: [...decision.retained],
    pruned: decision.pruned.map((entry) => ({ tupleDigest: entry.tupleDigest, reason: entry.reason })),
    tasks: [...decision.taskDigests],
    droppedTasks: decision.droppedTasks.map((entry) => ({
      taskDigest: entry.taskDigest,
      reason: entry.reason,
    })),
    replicates: decision.replicates,
    inputs: {
      reports: [...decision.inputs.reports],
      outcomes: [...decision.inputs.outcomes],
      informativeness: [...decision.inputs.informativeness],
    },
    notes: [...decision.notes],
  };
}

/** §5.2 `matrix-assembled` — the Matrix's identity plus the completeness a reader would check first. */
export function matrixAssembledPayload(
  plan: WavePlan,
  matrix: { readonly digest: string; readonly record: MatrixRecord },
): Payload {
  return {
    wave: plan.waveNumber,
    run: plan.run.digest,
    matrix: matrix.digest,
    expected: matrix.record.completeness.expected,
    judged: matrix.record.completeness.judged,
    runOutcome: matrix.record.completeness.runOutcome,
  };
}

/**
 * §5.2 `report-recorded`.
 *
 * `preregistered` is copied from the sealed Report, never asserted here: it is derived by
 * `benchmarking-aggregate` from the Run's analysis plan, and a journal that recorded the product's
 * *opinion* of preregistration beside a Report that derived otherwise would be the exact laundering
 * §6.2 forbids.
 */
export function reportRecordedPayload(
  plan: WavePlan,
  report: { readonly digest: string; readonly record: ReportRecord },
): Payload {
  return {
    wave: plan.waveNumber,
    kind: plan.kind,
    run: plan.run.digest,
    report: report.digest,
    method: { id: report.record.method.id, version: report.record.method.version },
    preregistered: report.record.preregistered ?? false,
    subjects: report.record.subjects.map((subject) => `sha256:${subject.digest.sha256}`),
  };
}

/**
 * Appends one wave event, filling in the sequence from the handle.
 *
 * `seq` stays explicit on the underlying store for the reason C7a states — a caller replaying entry
 * 7 after a crash is asking a different question from one appending the next entry. This helper is
 * for the ordinary appending case only, and it reads the next sequence from the handle it was
 * given, so a stale handle still refuses rather than overwriting.
 */
export function appendWaveEvent(
  handle: CampaignHandle,
  input: {
    readonly type: CampaignJournalEventType;
    readonly recordedAt: string;
    readonly payload: Payload;
  },
  options?: AppendOptions,
): CampaignHandle {
  const entry: CampaignJournalEntryInput = {
    seq: handle.state.nextSeq,
    type: input.type,
    recordedAt: input.recordedAt,
    payload: input.payload,
  };
  return appendCampaignEvent(handle, entry, options);
}
