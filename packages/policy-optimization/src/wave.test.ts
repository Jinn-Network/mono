// SPDX-License-Identifier: MIT

import { itemTaskDigest, parseBenchmark } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { decideAllocation } from "./allocation.js";
import { PolicyOptimizationError } from "./errors.js";
import { buildJournalEntry } from "./journal-entry.js";
import { WAVE_DERIVATION_EXTENSION_KEY } from "./tokens.js";
import {
  CANDIDATE,
  PARENT,
  benchmarkFor,
  campaignFor,
  runSettings,
  tasksFor,
} from "./testing/wave-fixtures.js";
import type { CampaignAllocation } from "./types.js";
import { checkStoppingRule, committedCells, deriveWaveBenchmark, planWave } from "./wave.js";
import { NO_CELLS_COMMITTED, type CommittedCells } from "./wave-types.js";

const DEV_TASKS = tasksFor(["alpha", "beta", "gamma"]);
const DEV = benchmarkFor({ name: "dev slate", tasks: DEV_TASKS, reveal: { policy: "immediate" } });
const PROMOTION = benchmarkFor({
  name: "promotion gate",
  tasks: tasksFor(["held-out one", "held-out two"]),
  reveal: { policy: "after-run" },
});
const CAMPAIGN_DIGEST = `sha256:${"c".repeat(64)}`;

function campaign(allocation: CampaignAllocation) {
  return campaignFor({
    developmentBenchmark: DEV.digest,
    promotionBenchmark: PROMOTION.digest,
    seeds: [PARENT],
    allocation,
  });
}

function category(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    if (error instanceof PolicyOptimizationError) return error.category;
    throw error;
  }
  throw new Error("expected a refusal");
}

function plan(options: {
  readonly allocation?: CampaignAllocation;
  readonly committed?: CommittedCells;
  readonly evaluationCells?: number;
  readonly hardCapCells?: number;
  readonly maxWaves?: number;
  readonly waveNumber?: number;
} = {}) {
  const allocation = options.allocation ?? { policyRef: "uniform/1.0", parameters: {} };
  const document = campaignFor({
    developmentBenchmark: DEV.digest,
    promotionBenchmark: PROMOTION.digest,
    seeds: [PARENT],
    allocation,
    ...(options.evaluationCells === undefined ? {} : { evaluationCells: options.evaluationCells }),
    ...(options.hardCapCells === undefined ? {} : { hardCapCells: options.hardCapCells }),
    ...(options.maxWaves === undefined ? {} : { maxWaves: options.maxWaves }),
  });
  const waveNumber = options.waveNumber ?? 1;
  const decision = decideAllocation({
    campaign: document,
    waveNumber,
    population: [PARENT, CANDIDATE],
    taskDigests: DEV.record.items.map(itemTaskDigest),
  });
  return planWave({
    campaign: document,
    campaignDigest: CAMPAIGN_DIGEST,
    waveNumber,
    candidates: [PARENT, CANDIDATE],
    allocation: decision,
    developmentBenchmarkBytes: DEV.bytes,
    settings: runSettings(),
    committed: options.committed ?? NO_CELLS_COMMITTED,
  });
}

describe("a wave is one sealed Run (§6.1)", () => {
  test("seals a Run over the retained arms and counts its own cells", () => {
    const wave = plan();
    expect(wave.kind).toBe("development");
    expect(wave.run.record.arms.map((arm) => arm.armId)).toEqual(["candidate", "parent"]);
    expect(wave.cells).toBe(DEV_TASKS.length * 2 * 1);
    expect(wave.run.record.replicates).toBe(1);
  });

  test("submissionBaseline is empty: the whole tuple travels on each arm", () => {
    const wave = plan();
    expect(wave.run.record.policy.submissionBaseline).toEqual({});
    for (const arm of wave.run.record.arms) {
      expect(Object.keys(arm.pinning).sort())
        .toEqual(["harness", "isolationPolicy", "loadout", "model"]);
    }
  });

  test("a development wave seals no analysis plan, so its Reports derive exploratory (§6.2)", () => {
    expect(plan().run.record.analysisPlan).toBeUndefined();
  });

  test("planning the same wave twice is byte-identical", () => {
    expect(plan().run.bytes).toEqual(plan().run.bytes);
    expect(plan().run.digest).toBe(plan().run.digest);
  });

  test("supplying a development Benchmark the campaign does not name is refused", () => {
    const other = benchmarkFor({
      name: "other slate",
      tasks: tasksFor(["delta"]),
      reveal: { policy: "immediate" },
    });
    expect(category(() => planWave({
      campaign: campaign({ policyRef: "uniform/1.0", parameters: {} }),
      campaignDigest: CAMPAIGN_DIGEST,
      waveNumber: 1,
      candidates: [PARENT],
      allocation: decideAllocation({
        campaign: campaign({ policyRef: "uniform/1.0", parameters: {} }),
        waveNumber: 1,
        population: [PARENT],
        taskDigests: other.record.items.map(itemTaskDigest),
      }),
      developmentBenchmarkBytes: other.bytes,
      settings: runSettings(),
      committed: NO_CELLS_COMMITTED,
    }))).toBe("wave-composition");
  });

  test("an allocation decided by another policy is refused (N3)", () => {
    const document = campaign({ policyRef: "uniform/1.0", parameters: {} });
    const decision = decideAllocation({
      campaign: document,
      waveNumber: 1,
      population: [PARENT, CANDIDATE],
      taskDigests: DEV.record.items.map(itemTaskDigest),
    });
    expect(category(() => planWave({
      campaign: campaign({ policyRef: "drop-bottom-k/1.0", parameters: { k: 1 } }),
      campaignDigest: CAMPAIGN_DIGEST,
      waveNumber: 1,
      candidates: [PARENT, CANDIDATE],
      // A `uniform/1.0` decision carried into a campaign that declares `drop-bottom-k/1.0`: the
      // journal would name a policy that never chose this arm set.
      allocation: decision,
      developmentBenchmarkBytes: DEV.bytes,
      settings: runSettings(),
      committed: NO_CELLS_COMMITTED,
    }))).toBe("allocation-policy");
  });

  test("an allocation retaining a candidate the population lacks is refused", () => {
    const document = campaign({ policyRef: "uniform/1.0", parameters: {} });
    const decision = decideAllocation({
      campaign: document,
      waveNumber: 1,
      population: [PARENT, CANDIDATE],
      taskDigests: DEV.record.items.map(itemTaskDigest),
    });
    expect(category(() => planWave({
      campaign: document,
      campaignDigest: CAMPAIGN_DIGEST,
      waveNumber: 1,
      candidates: [PARENT],
      allocation: decision,
      developmentBenchmarkBytes: DEV.bytes,
      settings: runSettings(),
      committed: NO_CELLS_COMMITTED,
    }))).toBe("wave-composition");
  });
});

describe("task selection can only be expressed as a derived Benchmark (records §7.3)", () => {
  test("selecting every task in order reuses the parent's exact bytes", () => {
    const derived = deriveWaveBenchmark({
      developmentBenchmarkBytes: DEV.bytes,
      taskDigests: DEV.record.items.map(itemTaskDigest),
      campaign: CAMPAIGN_DIGEST,
      waveNumber: 1,
    });
    expect(derived.bytes).toEqual(DEV.bytes);
    expect(derived.digest).toBe(DEV.digest);
    expect(derived.derivedFrom).toBeUndefined();
  });

  test("a restriction is its own record, and says on its face what it is", () => {
    const kept = [itemTaskDigest(DEV.record.items[0]!), itemTaskDigest(DEV.record.items[2]!)];
    const derived = deriveWaveBenchmark({
      developmentBenchmarkBytes: DEV.bytes,
      taskDigests: kept,
      campaign: CAMPAIGN_DIGEST,
      waveNumber: 3,
    });
    expect(derived.digest).not.toBe(DEV.digest);
    expect(derived.derivedFrom).toBe(DEV.digest);
    expect(derived.record.items.map(itemTaskDigest)).toEqual(kept);
    const extension = (parseBenchmark(derived.bytes) as unknown as Record<string, unknown>)[
      WAVE_DERIVATION_EXTENSION_KEY
    ];
    expect(extension).toEqual({ parent: DEV.digest, campaign: CAMPAIGN_DIGEST, wave: 3 });
  });

  test("the restriction keeps the parent's item order, whatever order the selection arrived in", () => {
    const reversed = [itemTaskDigest(DEV.record.items[2]!), itemTaskDigest(DEV.record.items[0]!)];
    const derived = deriveWaveBenchmark({
      developmentBenchmarkBytes: DEV.bytes,
      taskDigests: reversed,
      campaign: CAMPAIGN_DIGEST,
      waveNumber: 1,
    });
    expect(derived.record.items.map(itemTaskDigest)).toEqual([...reversed].reverse());
  });

  test("selecting a task the slate does not contain is refused", () => {
    expect(category(() => deriveWaveBenchmark({
      developmentBenchmarkBytes: DEV.bytes,
      taskDigests: ["f".repeat(64)],
      campaign: CAMPAIGN_DIGEST,
      waveNumber: 1,
    }))).toBe("wave-composition");
  });

  test("a wave over no tasks measures nothing", () => {
    expect(category(() => deriveWaveBenchmark({
      developmentBenchmarkBytes: DEV.bytes,
      taskDigests: [],
      campaign: CAMPAIGN_DIGEST,
      waveNumber: 1,
    }))).toBe("wave-composition");
  });
});

describe("budgets and the stopping rule bound what a campaign may plan", () => {
  test("a wave past the evaluation budget is refused", () => {
    expect(category(() => plan({ evaluationCells: 5, hardCapCells: 500 }))).toBe("budget-exceeded");
  });

  test("a wave past the hard cap is refused even when the evaluation budget allows it", () => {
    expect(category(() => plan({ evaluationCells: 500, hardCapCells: 5 }))).toBe("budget-exceeded");
  });

  test("already-committed cells count against both budgets", () => {
    expect(category(() => plan({
      evaluationCells: 8,
      hardCapCells: 500,
      committed: { development: 6, promotion: 0, total: 6 },
    }))).toBe("budget-exceeded");
  });

  test("max-waves/1.0 stops the campaign before the wave that would exceed it", () => {
    expect(checkStoppingRule(
      campaign({ policyRef: "uniform/1.0", parameters: {} }),
      { waveNumber: 4, committed: NO_CELLS_COMMITTED },
    )).toEqual({ stop: false });
    expect(category(() => plan({ maxWaves: 2, waveNumber: 3 }))).toBe("budget-exceeded");
  });

  test("budget-exhausted/1.0 reads the development spend", () => {
    const document = campaignFor({
      developmentBenchmark: DEV.digest,
      promotionBenchmark: PROMOTION.digest,
      seeds: [PARENT],
      allocation: { policyRef: "uniform/1.0", parameters: {} },
      evaluationCells: 10,
    });
    const exhausting = {
      ...document,
      stoppingRule: { ruleRef: "budget-exhausted/1.0", parameters: {} },
    } as typeof document;
    expect(checkStoppingRule(exhausting, {
      waveNumber: 2,
      committed: { development: 10, promotion: 0, total: 10 },
    }).stop).toBe(true);
    expect(checkStoppingRule(exhausting, {
      waveNumber: 2,
      committed: { development: 9, promotion: 0, total: 9 },
    }).stop).toBe(false);
  });

  test("an unrecognized stopping rule is refused, never read as 'never stop'", () => {
    const document = campaign({ policyRef: "uniform/1.0", parameters: {} });
    const unknown = { ...document, stoppingRule: { ruleRef: "vibes/1.0", parameters: {} } } as typeof document;
    expect(category(() => checkStoppingRule(unknown, {
      waveNumber: 1,
      committed: NO_CELLS_COMMITTED,
    }))).toBe("invalid-document");
  });
});

describe("committedCells is derived from the journal, never stored beside it", () => {
  const entry = (seq: number, type: "run-sealed" | "promotion-run-sealed" | "wave-planned", cells?: number) =>
    buildJournalEntry(CAMPAIGN_DIGEST, seq === 1 ? null : `sha256:${"a".repeat(64)}`, {
      seq,
      type,
      recordedAt: "2026-08-03T00:00:00Z",
      payload: cells === undefined ? {} : { cells },
    });

  test("folds development and promotion spend separately", () => {
    expect(committedCells([
      entry(1, "wave-planned"),
      entry(2, "run-sealed", 6),
      entry(3, "run-sealed", 4),
      entry(4, "promotion-run-sealed", 8),
    ])).toEqual({ development: 10, promotion: 8, total: 18 });
  });

  test("an empty journal has spent nothing", () => {
    expect(committedCells([])).toEqual(NO_CELLS_COMMITTED);
  });

  test("a sealed-Run entry with no cell count is refused rather than counted as zero", () => {
    expect(category(() => committedCells([entry(1, "run-sealed")]))).toBe("journal-integrity");
  });
});
