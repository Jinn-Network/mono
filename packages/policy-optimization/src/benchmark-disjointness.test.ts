// SPDX-License-Identifier: MIT

/**
 * Review disposition M4, at both gates: two slates sharing one item are refused when the campaign
 * is sealed with the bytes in hand, and again — unconditionally — at `DRAFT → EXPLORING`.
 */

import { describe, expect, test } from "vitest";
import { checkBenchmarkDisjointness } from "./benchmark-disjointness.js";
import { sealCampaign } from "./campaign.js";
import { PolicyOptimizationError } from "./errors.js";
import { checkExploringEntry } from "./exploring-entry.js";
import {
  PARENT,
  benchmarkFor,
  campaignFor,
  tasksFor,
} from "./testing/wave-fixtures.js";

const SHARED = tasksFor(["the task both slates contain"]);
const DEV_ONLY = tasksFor(["a development-only task"]);
const GATE_ONLY = tasksFor(["a held-out task"]);

const DEV = benchmarkFor({
  name: "dev slate",
  tasks: [...DEV_ONLY, ...SHARED],
  reveal: { policy: "immediate" },
});
const DISJOINT_DEV = benchmarkFor({
  name: "dev slate",
  tasks: DEV_ONLY,
  reveal: { policy: "immediate" },
});
const GATE = benchmarkFor({
  name: "promotion gate",
  tasks: [...GATE_ONLY, ...SHARED],
  reveal: { policy: "after-run" },
});
const DISJOINT_GATE = benchmarkFor({
  name: "promotion gate",
  tasks: GATE_ONLY,
  reveal: { policy: "after-run" },
});

const AFTER_RUN = { kind: "after-run", trustedRunNotClosed: true } as const;

function campaign(development: string, promotion: string) {
  return campaignFor({
    developmentBenchmark: development,
    promotionBenchmark: promotion,
    seeds: [PARENT],
    allocation: { policyRef: "uniform/1.0", parameters: {} },
  });
}

function seedResolution() {
  return [{ kind: "tuple" as const, digest: PARENT.tupleDigest, tuple: PARENT.tuple }];
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

describe("the predicate itself", () => {
  test("names every shared Task, sorted", () => {
    const result = checkBenchmarkDisjointness(
      { developmentBenchmark: DEV.digest, promotionBenchmark: GATE.digest },
      { development: DEV.bytes, promotion: GATE.bytes },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("shared-items");
      expect(result.shared).toEqual([SHARED[0]!.digest]);
    }
  });

  test("disjoint slates pass", () => {
    expect(checkBenchmarkDisjointness(
      { developmentBenchmark: DISJOINT_DEV.digest, promotionBenchmark: DISJOINT_GATE.digest },
      { development: DISJOINT_DEV.bytes, promotion: DISJOINT_GATE.bytes },
    )).toEqual({ ok: true });
  });

  test("bytes are re-digested, so a disjoint stand-in cannot buy a pass for the named pair", () => {
    const result = checkBenchmarkDisjointness(
      { developmentBenchmark: DEV.digest, promotionBenchmark: GATE.digest },
      // Honestly disjoint bytes — but not the ones the campaign names.
      { development: DISJOINT_DEV.bytes, promotion: DISJOINT_GATE.bytes },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("digest-mismatch");
  });
});

describe("gate 1 — campaign sealing (optional, because the bytes may not be held)", () => {
  test("refuses overlapping slates when the sealer supplies the bytes", () => {
    expect(category(() => sealCampaign(
      campaign(DEV.digest, GATE.digest),
      seedResolution(),
      { development: DEV.bytes, promotion: GATE.bytes },
    ))).toBe("benchmark-overlap");
  });

  test("seals disjoint slates", () => {
    const sealed = sealCampaign(
      campaign(DISJOINT_DEV.digest, DISJOINT_GATE.digest),
      seedResolution(),
      { development: DISJOINT_DEV.bytes, promotion: DISJOINT_GATE.bytes },
    );
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("a sealer without the bytes still seals — the property is closed at the next gate", () => {
    const sealed = sealCampaign(campaign(DEV.digest, GATE.digest), seedResolution());
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("gate 2 — DRAFT -> EXPLORING (unconditional)", () => {
  test("refuses the overlap the sealer was allowed to skip", () => {
    const result = checkExploringEntry(campaign(DEV.digest, GATE.digest), {
      benchmarkBytes: GATE.bytes,
      developmentBenchmarkBytes: DEV.bytes,
      revealContext: AFTER_RUN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("development-overlap");
      expect(result.detail).toContain(SHARED[0]!.digest);
    }
  });

  test("admits the disjoint pair", () => {
    const result = checkExploringEntry(campaign(DISJOINT_DEV.digest, DISJOINT_GATE.digest), {
      benchmarkBytes: DISJOINT_GATE.bytes,
      developmentBenchmarkBytes: DISJOINT_DEV.bytes,
      revealContext: AFTER_RUN,
    });
    expect(result.ok).toBe(true);
  });
});
