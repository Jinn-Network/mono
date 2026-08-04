// SPDX-License-Identifier: MIT

/**
 * Promotion (product design §6.3): one preregistered Run against the revealed committed Benchmark.
 *
 * > The promotion Run is preregistered with the campaign's objective methods in its `analysisPlan`,
 * > flat sampling per plan (no informativeness weighting), executed once.
 *
 * Four things this file enforces, each of which is the whole point of a separate promotion path
 * rather than "a wave with different parameters".
 *
 * 1. **The transition is legal only out of `EXPLORING`.** The `DRAFT → EXPLORING` gate
 *    (`checkExploringEntry`) already established that the promotion Benchmark was sealed, committed,
 *    and unrevealed *before any wave spent*. A campaign that reached `CONFIRMING` from anywhere else
 *    never passed that gate, so the held-out claim has no support.
 * 2. **Reveal happens here and is proved here.** At `EXPLORING`-entry the demand was
 *    `coverage.revealed === 0`; at `CONFIRMING` it is the exact inverse — every committed item's
 *    bytes present and digest-correct. Partial reveal is refused: a promotion Run over a slate half
 *    of which nobody can produce is not the gate the campaign committed to.
 * 3. **Flat sampling.** No task selection, no per-arm pruning, one Run-wide replicate count. The
 *    optional-stopping hazard §6.2 confines to exploration stays confined by construction, because
 *    this function takes no allocation decision at all.
 * 4. **Preregistration is real, not labelled.** The objective methods go into `analysisPlan` with
 *    their parameters verbatim, and `benchmarking-aggregate` derives `preregistered` by comparing
 *    those exact parameters against the Report's. FINDING F-C7b-3: that comparison includes
 *    `verdictRule`, which `produceReport` merges into the method parameters — so an objective method
 *    whose parameters omit `verdictRule` yields `preregistered: false` on a Run that plainly did
 *    preregister it. This function refuses such a campaign at plan time rather than shipping a
 *    Report that quietly understates its own discipline.
 */

import {
  checkRevealConsistency,
  documentDigest,
  expectedCellCount,
  parseBenchmark,
  type RunArm,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { planRun } from "@jinn-network/benchmarking-run";
import { buildWaveArms } from "./arms.js";
import { childPath, issue, refuse, refuseAll, type PolicyOptimizationIssue } from "./errors.js";
import type { CampaignLifecyclePhase } from "./journal-lifecycle.js";
import type { CampaignDocument } from "./types.js";
import type { AdmittedCandidate, CommittedCells, WavePlan, WaveRunSettings } from "./wave-types.js";

/** The proof that the gate's items are now in the open, in the caller's own bytes. */
export interface PromotionReveal {
  /** Exact sealed bytes of the Benchmark the campaign names as `target.promotionBenchmark`. */
  readonly benchmarkBytes: Uint8Array;
  /**
   * Committed Task digest → the exact revealed Task bytes. Every committed item, or none of this.
   *
   * The key is **bare lowercase hex** — a Benchmark item's `task.digest.sha256`, which is the same
   * spelling `ExecuteWaveInput.taskBytesFor` takes and the same one `checkRevealConsistency` looks
   * up (review disposition N2). Not `sha256:<hex>`: a prefixed key silently misses every lookup,
   * and a full reveal keyed that way reports as no reveal at all.
   */
  readonly revealed: ReadonlyMap<string, Uint8Array>;
}

export interface PromotionAdmission {
  readonly promotionBenchmark: `sha256:${string}`;
  readonly revealedItems: number;
  readonly committedItems: number;
}

/**
 * Checks the reveal without planning anything, so a caller can ask "may I promote?" before it has
 * assembled settings, arms, or a close instant.
 */
export function checkPromotionReveal(
  campaign: CampaignDocument,
  phase: CampaignLifecyclePhase,
  reveal: PromotionReveal,
): PromotionAdmission {
  if (phase !== "EXPLORING") {
    refuse("promotion-discipline", "phase",
      `a promotion Run is sealed out of EXPLORING, not ${phase}; only that path passed the committed-and-unrevealed gate (§6.3)`);
  }
  const digest = documentDigest(reveal.benchmarkBytes);
  if (digest !== campaign.target.promotionBenchmark) {
    refuse("promotion-benchmark", "target.promotionBenchmark",
      `supplied bytes digest to ${digest}, campaign names ${campaign.target.promotionBenchmark}`);
  }
  const record = parseBenchmark(reveal.benchmarkBytes);
  if (record.items.length === 0) {
    refuse("promotion-benchmark", "items", "a promotion gate with no items gates nothing");
  }
  const consistency = checkRevealConsistency(record, reveal.revealed);
  if (!consistency.ok) {
    refuse("promotion-benchmark", "reveal",
      `reveal-consistency failed on ${consistency.mismatched.join(", ")}: the revealed bytes do not match their commitments`);
  }
  if (consistency.coverage.revealed !== consistency.coverage.committed) {
    refuse("promotion-discipline", "reveal",
      `${consistency.coverage.revealed} of ${consistency.coverage.committed} committed items revealed; the promotion Run runs the whole gate or none of it (§6.3)`);
  }
  return {
    promotionBenchmark: digest,
    revealedItems: consistency.coverage.revealed,
    committedItems: consistency.coverage.committed,
  };
}

/**
 * The campaign's objective, as a Run `analysisPlan`.
 *
 * Parameters travel verbatim. Rewriting them here — normalizing, defaulting, adding a missing
 * `verdictRule` — would make the plan agree with the Report by construction, which is exactly the
 * agreement `derivePreregistered` exists to test.
 */
export function objectiveAnalysisPlan(campaign: CampaignDocument): RunRecord["analysisPlan"] {
  const errors: PolicyOptimizationIssue[] = [];
  campaign.objective.methods.forEach((method, index) => {
    if (typeof method.parameters["verdictRule"] !== "string") {
      errors.push(issue("promotion-discipline", childPath("objective.methods", index),
        `method ${method.id}@${method.version} must carry a verdictRule parameter: benchmarking-aggregate merges verdictRule into the method parameters it compares against the analysis plan, so omitting it derives preregistered=false on a Run that did preregister (F-C7b-3)`));
    }
  });
  if (errors.length > 0) refuseAll(errors);
  return campaign.objective.methods.map((method) => ({
    method: method.id,
    version: method.version,
    parameters: { ...method.parameters },
  }));
}

export interface PlanPromotionRunInput {
  readonly campaign: CampaignDocument;
  readonly campaignDigest: string;
  /** The derived lifecycle phase the campaign is in right now. Must be `EXPLORING`. */
  readonly phase: CampaignLifecyclePhase;
  /** The surviving population. Every one of these becomes an arm — promotion prunes nothing. */
  readonly candidates: readonly AdmittedCandidate[];
  readonly reveal: PromotionReveal;
  readonly settings: WaveRunSettings;
  readonly committed: CommittedCells;
  /** Run-wide, flat. Defaults to 1. */
  readonly replicates?: number;
  /** The wave number this Run follows, for journal ordering only. */
  readonly waveNumber: number;
}

export interface PlannedPromotion {
  readonly plan: WavePlan;
  readonly admission: PromotionAdmission;
}

/** Plans and seals the campaign's single promotion Run. */
export function planPromotionRun(input: PlanPromotionRunInput): PlannedPromotion {
  const admission = checkPromotionReveal(input.campaign, input.phase, input.reveal);
  const record = parseBenchmark(input.reveal.benchmarkBytes);
  const replicates = input.replicates ?? 1;
  if (!Number.isSafeInteger(replicates) || replicates < 1) {
    refuse("promotion-discipline", "replicates", "replicates is a positive integer");
  }

  const arms = buildWaveArms(input.campaign, input.candidates);
  const run = planRun({
    benchmarkDigest: admission.promotionBenchmark,
    owner: input.settings.owner,
    arms: arms.map((arm) => ({ armId: arm.armId, pinning: arm.pinning }) as RunArm),
    replicates,
    policy: {
      completenessFloor: input.settings.completenessFloor,
      cellWindow: input.settings.cellWindowMs,
      replacement: input.settings.replacement,
      independence: input.settings.independence,
      evaluation: input.settings.evaluation,
      submissionBaseline: {},
      ...(input.settings.participantExclusions === undefined
        ? {}
        : { participantExclusions: [...input.settings.participantExclusions] }),
    },
    analysisPlan: objectiveAnalysisPlan(input.campaign),
    ...(input.settings.venue === undefined
      ? { venue: { kind: "self-run" as const } }
      : { venue: input.settings.venue }),
    closeAt: input.settings.closeAt,
  });

  const cells = expectedCellCount(record, run.record);
  if (input.committed.total + cells > input.campaign.budgets.hardCap.maxCells) {
    refuse("budget-exceeded", "budgets.hardCap.maxCells",
      `the promotion Run's ${cells} cells would take total spend to ${input.committed.total + cells}, past the ${input.campaign.budgets.hardCap.maxCells}-cell hard cap`);
  }

  return {
    admission,
    plan: {
      kind: "promotion",
      waveNumber: input.waveNumber,
      campaign: input.campaignDigest,
      benchmark: {
        digest: admission.promotionBenchmark,
        bytes: input.reveal.benchmarkBytes,
        record,
      },
      run: { digest: run.digest, bytes: run.bytes, record: run.record },
      arms,
      cells,
    },
  };
}
