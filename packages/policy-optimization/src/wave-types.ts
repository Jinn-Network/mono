// SPDX-License-Identifier: MIT

/**
 * The type vocabulary of the wave engine (product design §6.1–§6.3).
 *
 * Two families of shape live here and nothing else — no logic, no validation.
 *
 * 1. **What the engine composes.** A wave is one preregistered benchmarking Run (§6.1), so the
 *    plan/execution/assembly shapes are thin wrappers over `@jinn-network/benchmarking-run`'s own
 *    types rather than parallel definitions. Where a field already exists on `InScopeCell` it is
 *    reused by `Pick`, so the two surfaces cannot drift.
 * 2. **Narrow ports for signal this unit does not produce.** §6.2's allocator consumes prior-wave
 *    Reports, the outcomes projection's organic bucket, and curation's task informativeness. The
 *    adapters that produce all three are C8's; this unit declares the smallest row shape each
 *    decision actually reads and consumes it as an argument. The rows are **mirrored, never
 *    imported** — importing `task-supply/curation` would put a tier-3 supply package inside the
 *    product's dependency graph for three integers.
 */

import type {
  CellStatusEvent,
  CellStatusKind,
  InScopeCell,
  IntegrityTier,
  TrustResolver,
} from "@jinn-network/benchmarking-run";
import type { BenchmarkRecord, RunRecord } from "@jinn-network/benchmarking-records";
import type { LocalCellPinningEvidence } from "@jinn-network/benchmarking-local";
import type { ExecutionPolicyTuple, RequirementEntries } from "@jinn-network/policy-identity";
import type { JsonValue, PolicyRef } from "./types.js";

/**
 * A candidate the campaign has **already admitted** (product §7.3).
 *
 * Admission itself is C7c's: manifest validation, digest-correct materialization, the
 * frozen-axes and mutation-surface checks, the held-out lexical scan, the smoke canary. The wave
 * engine takes the outcome of all of that and nothing more, which is what makes the
 * replaceability falsifier possible — a second proposer's candidate arrives here in exactly this
 * shape, and the engine cannot tell which proposer produced it.
 *
 * `source` is the substrate §5.1 typed reference used for **attribution**: population membership
 * is keyed by `tupleDigest` (§7.3), so a second manifest proposing an already-admitted tuple joins
 * this arm rather than minting a new one, and `source` names the *first-admitted* manifest.
 */
export interface AdmittedCandidate {
  /** The Run arm this candidate occupies. `[A-Za-z0-9_-]{1,64}`, unique within a wave. */
  readonly armId: string;
  /** `sha256:<64 lowercase hex>` over the tuple's canonical bytes — the population key. */
  readonly tupleDigest: string;
  readonly tuple: ExecutionPolicyTuple;
  readonly source: PolicyRef;
}

/** One arm of a planned wave: the candidate, and the run pinning its tuple expresses to. */
export interface WaveArm {
  readonly armId: string;
  readonly tupleDigest: string;
  readonly source: PolicyRef;
  /** `expressAsRunPinning(tuple)` — the substrate §4.1 expression rule, byte-exact. */
  readonly pinning: RequirementEntries;
}

/**
 * Run-shaped settings a campaign document deliberately does not carry.
 *
 * The campaign fixes *what is optimized, what counts as better, and the budget* (§5.1) — it says
 * nothing about who owns the Run, when it closes, or how long a cell may take. Those are per-wave
 * operational choices, so they arrive per wave instead of being frozen into an immutable document
 * that would then have to be re-sealed to change a timeout.
 */
export interface WaveRunSettings {
  /** Agent IRI of the Run owner. */
  readonly owner: string;
  /** RFC 3339 with an offset. The Matrix's close boundary is exactly this instant on a local venue. */
  readonly closeAt: string;
  readonly cellWindowMs: number;
  /** Decimal string in (0,1]. */
  readonly completenessFloor: string;
  readonly independence: RunRecord["policy"]["independence"];
  readonly replacement: RunRecord["policy"]["replacement"];
  readonly evaluation: RunRecord["policy"]["evaluation"];
  readonly venue?: RunRecord["venue"];
  readonly participantExclusions?: readonly string[];
}

/** Cells already committed by this campaign's sealed Runs, split the way the budgets are. */
export interface CommittedCells {
  /** Cells sealed into development waves — bounded by `budgets.evaluation.maxCells`. */
  readonly development: number;
  /** Cells sealed into the promotion Run. */
  readonly promotion: number;
  /** Development + promotion — bounded by `budgets.hardCap.maxCells`. */
  readonly total: number;
}

export const NO_CELLS_COMMITTED: CommittedCells = { development: 0, promotion: 0, total: 0 };

/** A sealed wave: the Benchmark it runs, the Run that names it, and the arms it compares. */
export interface WavePlan {
  /** `development` waves may prune and select; the `promotion` wave may do neither (§6.2/§6.3). */
  readonly kind: "development" | "promotion";
  /** 1-based. The promotion wave carries the number it would have had, for ordering only. */
  readonly waveNumber: number;
  /** The sealed campaign document's digest. */
  readonly campaign: string;
  /**
   * The Benchmark this wave's Run names.
   *
   * For a promotion wave this is the campaign's `promotionBenchmark`, unchanged. For a
   * development wave whose allocation selected a task subset it is a **derived** Benchmark —
   * the campaign's development slate restricted to the selected items — because a Run's expected
   * cell set is the full cartesian product of its Benchmark's items (records §7.3) and there is
   * no other way to express "run these tasks and not those".
   */
  readonly benchmark: {
    readonly digest: `sha256:${string}`;
    readonly bytes: Uint8Array;
    readonly record: BenchmarkRecord;
    /** The campaign-level slate this Benchmark was derived from, when it is a restriction. */
    readonly derivedFrom?: string;
  };
  readonly run: {
    readonly digest: `sha256:${string}`;
    readonly bytes: Uint8Array;
    readonly record: RunRecord;
  };
  readonly arms: readonly WaveArm[];
  /** `items × arms × replicates` — what this wave spends. */
  readonly cells: number;
  /** Present on development waves; a promotion wave is flat by construction (§6.3). */
  readonly allocation?: AllocationDecision;
}

// --- §6.2 allocation ---------------------------------------------------------------------------

/**
 * The exact provenance of everything an allocation decision read.
 *
 * §6.2: "Every pruning decision is journaled with the rows and Reports it consumed, so
 * survivorship is post-hoc auditable." Digests only — the journal orders decisions, it does not
 * copy the evidence.
 */
export interface AllocationInputRefs {
  /** Report record digests, sorted. */
  readonly reports: readonly string[];
  /** Outcomes-projection row references, sorted. */
  readonly outcomes: readonly string[];
  /** Curation row references, sorted. */
  readonly informativeness: readonly string[];
}

export interface PrunedCandidate {
  readonly tupleDigest: string;
  readonly reason: string;
}

export interface DroppedTask {
  readonly taskDigest: string;
  readonly reason: string;
}

/**
 * What the allocator decided for the next wave.
 *
 * Deliberately *not* per-candidate cell counts. A benchmarking Run carries one Run-wide
 * `replicates` and runs the full cartesian product of its Benchmark's items (records §7.3), so
 * the only allocation a single sealed Run can express is **arm membership × task membership ×
 * one replicate count**. See F-C7b-2: differential per-candidate replication would need one Run
 * per stratum, and the design's "a sealed Run is never amended" (§6.1) makes that a change to the
 * wave/Run correspondence rather than a parameter.
 */
export interface AllocationDecision {
  /** Echoes `campaign.allocation.policyRef`, so a journaled decision names the policy that made it. */
  readonly policyRef: string;
  readonly waveNumber: number;
  /** Retained candidates' tuple digests, sorted. Every one of these becomes an arm. */
  readonly retained: readonly string[];
  readonly pruned: readonly PrunedCandidate[];
  /** Task digests this wave runs, in the development Benchmark's own item order. */
  readonly taskDigests: readonly string[];
  readonly droppedTasks: readonly DroppedTask[];
  readonly replicates: number;
  readonly inputs: AllocationInputRefs;
  /** Why the policy did what it did, in the policy's own words. Never a score. */
  readonly notes: readonly string[];
}

// --- narrow ports for signal this unit consumes but does not produce (§6.2, §8.2) ---------------

/**
 * One arm's value from one prior-wave Report, carried **verbatim** as the registry method emitted
 * it.
 *
 * The product never parses a Report's `results` block and never computes an estimate from it
 * (program ruling R3): the adapter that read the Report hands over the decimal string the method
 * already published, and the allocator's only operation on it is an exact comparison. A method
 * whose output is not a plain decimal string simply cannot be ranked on, which is the honest
 * failure — the alternative is the product inventing a scalar the Report never claimed.
 */
export interface WaveReportRow {
  /** `sha256:<hex>` of the Report record the value was read from. */
  readonly reportDigest: string;
  /** The wave that produced the Report; the allocator ranks on the most recent one per arm. */
  readonly waveNumber: number;
  readonly tupleDigest: string;
  /** The registry method that produced it — `{id, version}` of a campaign objective method. */
  readonly method: { readonly id: string; readonly version: string };
  /** A non-negative decimal string, exactly as sealed in the Report. */
  readonly value: string;
}

/**
 * One `(tupleDigest, bucket)` row of the outcomes projection, mirrored from
 * `@jinn-network/policy-outcomes`' `PolicyOutcomesRow` down to the members a decision reads.
 *
 * §8.1: observation buys *direction*, never a claim. §6.2 states the hazard plainly — this bucket
 * is operator-selected and manipulable, so poisoned signal can prune the genuinely best candidate
 * before promotion. That is why it appears here only as a tie-break and why every row it consumed
 * is journaled.
 */
export interface OutcomesProjectionRow {
  /** A reference the row can be re-derived from — an input-ref digest, not the row's content. */
  readonly rowRef: string;
  readonly tupleDigest: string;
  readonly bucket: "benchmark" | "organic";
  /** `num` = pass, `den` = pass + fail, over decision-grade verdicts. Exact, never a float. */
  readonly passRate: { readonly num: number; readonly den: number };
}

/**
 * One `(taskDigest, bucket)` curation row, mirrored down to what saturation reads.
 *
 * §6.2: "task informativeness from the curation projection (saturated tasks discriminate
 * nothing)". A task everyone passes and a task nobody passes are equally uninformative; both are
 * detected by comparing the exact observed rate against caller-supplied bounds, exactly as
 * curation's own `compareRateTo` does. No default threshold exists there and none is invented here.
 */
export interface TaskInformativenessRow {
  readonly rowRef: string;
  readonly taskDigest: string;
  readonly bucket: "benchmark" | "organic";
  readonly passRate: { readonly num: number; readonly den: number };
}

/** An exact rational threshold — curation's `Ratio`, mirrored. */
export interface RateBound {
  readonly num: number;
  readonly den: number;
}

// --- execution ----------------------------------------------------------------------------------

/** What the dispatch loop established about one expected cell. */
export interface WaveDispatch {
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly taskDigest: string;
  /** 0 when the cell was never dispatched — a legal outcome that assembly accounts for. */
  readonly dispatches: number;
  readonly accounted?: number;
  readonly attempt?: string;
  readonly submissionDigest?: `sha256:${string}`;
  readonly terminal?: CellStatusKind;
  readonly detail?: string;
}

export interface WaveExecution {
  readonly runDigest: `sha256:${string}`;
  readonly events: readonly CellStatusEvent[];
  /** One entry per expected cell, ordered by `cellKey`. */
  readonly dispatches: readonly WaveDispatch[];
  /** True when the owner cancelled or aborted; the Matrix's run outcome becomes `cancelled`. */
  readonly cancelled: boolean;
}

/**
 * Everything the venue recorded about one cell beyond its dispatch.
 *
 * Delivery, evaluation, and treatment-fidelity evidence are the venue's and the evaluator's, not
 * the campaign's — this product adds no execution, assembly, or aggregation machinery (§6.1). The
 * delivery/verdict members are `Pick`ed off `InScopeCell` rather than restated, so a change to the
 * benchmarking port contract is a compile error here instead of a silent divergence.
 */
export type WaveCellEvidence =
  & Pick<
    InScopeCell,
    | "deliveryBytes"
    | "deliveryDigest"
    | "evaluationSpec"
    | "evaluationSpecDigest"
    | "evaluationTerminal"
    | "verdicts"
  >
  & {
    /** Admission-gate result plus Runtime Observations, for the local pinning bridge. */
    readonly pinning?: LocalCellPinningEvidence;
    readonly cost?: { readonly value: string; readonly unit: string };
    readonly latencyMs?: number;
  };

export interface WaveCellEvidencePort {
  evidenceFor(
    cellKey: string,
  ): WaveCellEvidence | undefined | Promise<WaveCellEvidence | undefined>;
}

/** The venue facts assembly needs beyond the cells themselves. */
export interface WaveAssemblyVenue {
  /**
   * Every isolation-policy value this venue's launchers can produce. Required, exactly as
   * `@jinn-network/benchmarking-local` requires it: there is no safe default, and a host that
   * omits its inventory would inherit someone else's assumption and collect a silent `match`.
   */
  readonly isolationInventory: readonly string[];
  readonly trust?: TrustResolver;
  /** Admission receipt per cell → integrity tier; absent means `attested-only` (§8.4). */
  readonly admissionReceiptFor?: (
    cellKey: string,
  ) => { readonly zeroReplayVariance: boolean; readonly externalCapabilities: boolean } | undefined;
}

export type { CellStatusEvent, CellStatusKind, IntegrityTier, JsonValue };
