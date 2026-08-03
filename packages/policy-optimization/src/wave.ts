// SPDX-License-Identifier: MIT

/**
 * Wave planning (product design §6.1): a wave **is** one sealed benchmarking Run.
 *
 * > Every evaluation wave is one preregistered benchmarking Run […] This product adds **no
 * > execution, assembly, or aggregation machinery** — re-implementing any of it is forbidden
 * > duplication.
 *
 * So everything structural here is composition: arms come from `expressAsRunPinning`, the Run is
 * sealed by `planRun`, the Benchmark by `sealBenchmark`, the cell count by `expectedCellCount`.
 * What this file *owns* is the three product decisions benchmarking deliberately declines to make —
 * which Benchmark a wave runs, whether the campaign may afford it, and whether the campaign has
 * already agreed to stop.
 */

import {
  documentDigest,
  expectedCellCount,
  parseBenchmark,
  sealBenchmark,
  type BenchmarkRecord,
  type RunArm,
} from "@jinn-network/benchmarking-records";
import { planRun } from "@jinn-network/benchmarking-run";
import { buildWaveArms } from "./arms.js";
import { childPath, issue, refuse, refuseAll, type PolicyOptimizationIssue } from "./errors.js";
import { WAVE_DERIVATION_EXTENSION_KEY } from "./tokens.js";
import type { CampaignDocument, JsonValue } from "./types.js";
import type { CampaignJournalEntry } from "./journal-entry.js";
import type {
  AdmittedCandidate,
  AllocationDecision,
  CommittedCells,
  WaveArm,
  WavePlan,
  WaveRunSettings,
} from "./wave-types.js";

/**
 * Cells this campaign has already sealed into Runs, read back off its own journal.
 *
 * Derived rather than stored: the journal is the ordering of decisions, and a stored running total
 * beside it is a second copy of a fact the ordering already carries — one that can disagree with
 * the entries after a partial write. `run-sealed` and `promotion-run-sealed` payloads carry
 * `cells`; an entry that does not is a payload this package did not write, and is refused rather
 * than counted as zero.
 */
export function committedCells(entries: readonly CampaignJournalEntry[]): CommittedCells {
  let development = 0;
  let promotion = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "run-sealed" && entry.type !== "promotion-run-sealed") continue;
    const cells = entry.payload["cells"];
    if (typeof cells !== "number" || !Number.isSafeInteger(cells) || cells < 0) {
      refuse("journal-integrity", `entries.${index}.payload.cells`,
        `a ${entry.type} entry must carry its sealed cell count; budget accounting cannot skip an entry it cannot read`);
    }
    if (entry.type === "run-sealed") development += cells;
    else promotion += cells;
  }
  return { development, promotion, total: development + promotion };
}

// --- the stopping rule (§5.1: mandatory; exploration cannot run open-ended) ----------------------

export const STOPPING_RULE_REFS = ["max-waves/1.0", "budget-exhausted/1.0"] as const;

export type StoppingRuleResult =
  | { readonly stop: false }
  | { readonly stop: true; readonly reason: string };

/**
 * Has the campaign already agreed to stop before this wave?
 *
 * The rule is mandatory in the document (§5.1) and evaluated here, at the one moment where
 * evaluating it changes anything: immediately before a wave would spend. An unrecognized rule
 * reference is refused rather than treated as "never stop" — a campaign that believed it was
 * bounded and was not is the exact failure the mandatory field exists to prevent.
 */
export function checkStoppingRule(
  campaign: CampaignDocument,
  context: { readonly waveNumber: number; readonly committed: CommittedCells },
): StoppingRuleResult {
  const { ruleRef, parameters } = campaign.stoppingRule;
  if (ruleRef === "max-waves/1.0") {
    const maxWaves = parameters["maxWaves"];
    if (typeof maxWaves !== "number" || !Number.isSafeInteger(maxWaves) || maxWaves < 1) {
      refuse("invalid-document", "stoppingRule.parameters.maxWaves",
        "max-waves/1.0 requires an integer maxWaves >= 1");
    }
    return context.waveNumber > maxWaves
      ? { stop: true, reason: `max-waves/1.0: wave ${context.waveNumber} exceeds maxWaves=${maxWaves}` }
      : { stop: false };
  }
  if (ruleRef === "budget-exhausted/1.0") {
    return context.committed.development >= campaign.budgets.evaluation.maxCells
      ? {
        stop: true,
        reason: `budget-exhausted/1.0: ${context.committed.development} of ${campaign.budgets.evaluation.maxCells} evaluation cells already sealed`,
      }
      : { stop: false };
  }
  refuse("invalid-document", "stoppingRule.ruleRef",
    `unknown stopping rule ${JSON.stringify(ruleRef)}; v0 implements ${STOPPING_RULE_REFS.join(", ")}`);
}

// --- the wave's Benchmark -----------------------------------------------------------------------

export interface DerivedWaveBenchmark {
  readonly digest: `sha256:${string}`;
  readonly bytes: Uint8Array;
  readonly record: BenchmarkRecord;
  readonly derivedFrom?: string;
}

/**
 * The Benchmark a development wave runs.
 *
 * A Run's expected cell set is the **full cartesian product** of its Benchmark's items × arms ×
 * replicates (records §7.3). There is no "run a subset of this slate" knob, so §6.2's task
 * selection can only be expressed by naming a different Benchmark: the campaign's development
 * slate restricted to the selected items, sealed as its own record.
 *
 * The restriction is recorded **on the derived record**, under a namespaced extension key
 * (TEP §21.3), rather than only in the campaign's private journal. A restricted slate carries the
 * parent's `name` and `version`, so anyone cataloguing by name would otherwise hold two different
 * item sets under one label with nothing on either record to tell them apart.
 *
 * When the selection is the whole slate in its own order, the parent's **exact bytes** are reused.
 * Re-sealing an already-sealed record to get "the same" bytes is a claim, and this is the one place
 * the claim is free not to make.
 */
export function deriveWaveBenchmark(input: {
  readonly developmentBenchmarkBytes: Uint8Array;
  readonly taskDigests: readonly string[];
  readonly campaign: string;
  readonly waveNumber: number;
}): DerivedWaveBenchmark {
  const record = parseBenchmark(input.developmentBenchmarkBytes);
  const parentDigest = documentDigest(input.developmentBenchmarkBytes);
  const available = record.items.map((item) => item.task.digest?.sha256);
  const selection = new Set(input.taskDigests);

  const errors: PolicyOptimizationIssue[] = [];
  for (const [index, taskDigest] of input.taskDigests.entries()) {
    if (!available.includes(taskDigest)) {
      errors.push(issue("wave-composition", childPath("allocation.taskDigests", index),
        `task ${taskDigest} is not an item of the development Benchmark ${parentDigest}`));
    }
  }
  if (selection.size !== input.taskDigests.length) {
    errors.push(issue("wave-composition", "allocation.taskDigests", "duplicate task selection"));
  }
  if (selection.size === 0) {
    errors.push(issue("wave-composition", "allocation.taskDigests", "a wave over no tasks measures nothing"));
  }
  if (errors.length > 0) refuseAll(errors);

  const items = record.items.filter((item) => selection.has(item.task.digest?.sha256 ?? ""));
  if (items.length === record.items.length) {
    return {
      digest: parentDigest,
      bytes: input.developmentBenchmarkBytes,
      record,
    };
  }

  const sealed = sealBenchmark({
    ...record,
    items,
    [WAVE_DERIVATION_EXTENSION_KEY]: {
      parent: parentDigest,
      campaign: input.campaign,
      wave: input.waveNumber,
    },
  });
  return {
    digest: sealed.digest,
    bytes: sealed.bytes,
    record: parseBenchmark(sealed.bytes),
    derivedFrom: parentDigest,
  };
}

// --- planning ------------------------------------------------------------------------------------

export interface PlanWaveInput {
  readonly campaign: CampaignDocument;
  /** The sealed campaign document's digest — what every journal entry names. */
  readonly campaignDigest: string;
  readonly waveNumber: number;
  /** The admitted population. Arms are the subset the allocation retained. */
  readonly candidates: readonly AdmittedCandidate[];
  readonly allocation: AllocationDecision;
  /** Exact sealed bytes of the Benchmark the campaign names as `target.developmentBenchmark`. */
  readonly developmentBenchmarkBytes: Uint8Array;
  readonly settings: WaveRunSettings;
  readonly committed: CommittedCells;
}

function runPolicy(settings: WaveRunSettings, arms: readonly WaveArm[]) {
  void arms;
  return {
    completenessFloor: settings.completenessFloor,
    cellWindow: settings.cellWindowMs,
    replacement: settings.replacement,
    independence: settings.independence,
    evaluation: settings.evaluation,
    // Empty, and necessarily so: every arm carries its whole tuple expression, and the Run schema
    // forbids an arm key colliding with a baseline key (records §7.79). See `arms.ts`.
    submissionBaseline: {},
    ...(settings.participantExclusions === undefined
      ? {}
      : { participantExclusions: [...settings.participantExclusions] }),
  };
}

function assertAffordable(
  campaign: CampaignDocument,
  kind: WavePlan["kind"],
  committed: CommittedCells,
  cells: number,
): void {
  const errors: PolicyOptimizationIssue[] = [];
  if (kind === "development" && committed.development + cells > campaign.budgets.evaluation.maxCells) {
    errors.push(issue("budget-exceeded", "budgets.evaluation.maxCells",
      `this wave's ${cells} cells would take development spend to ${committed.development + cells}, past the ${campaign.budgets.evaluation.maxCells}-cell evaluation budget`));
  }
  if (committed.total + cells > campaign.budgets.hardCap.maxCells) {
    errors.push(issue("budget-exceeded", "budgets.hardCap.maxCells",
      `this wave's ${cells} cells would take total spend to ${committed.total + cells}, past the ${campaign.budgets.hardCap.maxCells}-cell hard cap`));
  }
  if (errors.length > 0) refuseAll(errors);
}

/**
 * Plans and seals one development wave.
 *
 * The order of the checks is the order in which they can be true: stop before spending, compose
 * the arms, derive the Benchmark, count the cells, *then* check affordability against a number that
 * actually exists. A budget check run against an estimate would be a different check.
 */
export function planWave(input: PlanWaveInput): WavePlan {
  if (!Number.isSafeInteger(input.waveNumber) || input.waveNumber < 1) {
    refuse("wave-composition", "waveNumber", "waveNumber is 1-based");
  }
  if (input.allocation.waveNumber !== input.waveNumber) {
    refuse("wave-composition", "allocation.waveNumber",
      `the allocation decides wave ${input.allocation.waveNumber}; this plan is wave ${input.waveNumber}`);
  }
  // Review disposition N3. The decision echoes the policy that made it; a plan built from a
  // decision some *other* policy produced would journal this campaign's `policyRef` beside an arm
  // set it never chose — the one thing the `allocation-decided` entry exists to make auditable.
  if (input.allocation.policyRef !== input.campaign.allocation.policyRef) {
    refuse("allocation-policy", "allocation.policyRef",
      `the allocation was decided by ${input.allocation.policyRef}; this campaign declares ${input.campaign.allocation.policyRef}`);
  }
  const stopping = checkStoppingRule(input.campaign, {
    waveNumber: input.waveNumber,
    committed: input.committed,
  });
  if (stopping.stop) {
    refuse("budget-exceeded", "stoppingRule", `${stopping.reason}; the campaign has already agreed to stop`);
  }

  const byTuple = new Map(input.candidates.map((candidate) => [candidate.tupleDigest, candidate]));
  const missing = input.allocation.retained.filter((tupleDigest) => !byTuple.has(tupleDigest));
  if (missing.length > 0) {
    refuse("wave-composition", "allocation.retained",
      `the allocation retained ${missing.join(", ")}, which the candidate population does not contain`);
  }
  const retained = input.allocation.retained.map((tupleDigest) => byTuple.get(tupleDigest)!);
  const arms = buildWaveArms(input.campaign, retained);

  const suppliedDevelopmentDigest = documentDigest(input.developmentBenchmarkBytes);
  if (suppliedDevelopmentDigest !== input.campaign.target.developmentBenchmark) {
    refuse("wave-composition", "developmentBenchmarkBytes",
      `supplied development Benchmark digests to ${suppliedDevelopmentDigest}, campaign names ${input.campaign.target.developmentBenchmark}`);
  }
  const benchmark = deriveWaveBenchmark({
    developmentBenchmarkBytes: input.developmentBenchmarkBytes,
    taskDigests: input.allocation.taskDigests,
    campaign: input.campaignDigest,
    waveNumber: input.waveNumber,
  });

  const run = planRun({
    benchmarkDigest: benchmark.digest,
    owner: input.settings.owner,
    arms: arms.map((arm) => ({ armId: arm.armId, pinning: arm.pinning }) as RunArm),
    replicates: input.allocation.replicates,
    policy: runPolicy(input.settings, arms),
    // No `analysisPlan`, deliberately. §6.2: "Dev-wave Reports are labeled exploratory by
    // construction (their `preregistered` flag reflects exactly what was in the Run's analysis plan
    // and nothing else)." An adaptive process that preregistered its objective would be harvesting
    // the preregistered label from a wave whose arm set was chosen after seeing the last one.
    ...(input.settings.venue === undefined ? { venue: { kind: "self-run" as const } } : { venue: input.settings.venue }),
    closeAt: input.settings.closeAt,
  });

  const cells = expectedCellCount(benchmark.record, run.record);
  assertAffordable(input.campaign, "development", input.committed, cells);

  return {
    kind: "development",
    waveNumber: input.waveNumber,
    campaign: input.campaignDigest,
    benchmark,
    run: { digest: run.digest, bytes: run.bytes, record: run.record },
    arms,
    cells,
    allocation: input.allocation,
  };
}

export type { JsonValue };
