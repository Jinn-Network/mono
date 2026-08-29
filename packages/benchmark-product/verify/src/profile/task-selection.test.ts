// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the cold verifier's task-selection contradiction checks (issue #2980).
 *
 * Sealing makes the declaration unforgeable after the lock; it does not make it true. These tests
 * pin the part sealing cannot settle: the two stronger modes assert that someone other than the
 * claimant chose the tasks, and the sealed Benchmark and Run either support that or contradict it.
 */

import { describe, expect, test } from "vitest";
import {
  TASK_SELECTION_EXTENSION,
  type BenchmarkRecord,
  type RunRecord,
  type TaskSelectionMode,
} from "@jinn-network/benchmarking-records";
import { BenchmarkProductError } from "./errors.js";
import { assertTaskSelectionConsistency, declaredTaskSelectionMode } from "./task-selection.js";

const CLAIMANT = "did:example:claimant";
const CURATOR = "did:example:curator";
const LOCK = "2026-08-20T00:00:00Z";

function run(options: {
  readonly mode?: TaskSelectionMode | string;
  readonly owner?: string;
  readonly closeAt?: string;
} = {}): RunRecord {
  const record: Record<string, unknown> = {
    owner: options.owner ?? CLAIMANT,
    closeAt: options.closeAt ?? LOCK,
  };
  if (options.mode !== undefined) record[TASK_SELECTION_EXTENSION] = { mode: options.mode };
  return record as unknown as RunRecord;
}

function benchmark(reveal: BenchmarkRecord["reveal"], author?: string): BenchmarkRecord {
  return { reveal, ...(author === undefined ? {} : { author }) } as unknown as BenchmarkRecord;
}

const IMMEDIATE = benchmark({ policy: "immediate" }, CURATOR);
const AFTER_RUN = benchmark({ policy: "after-run" }, CURATOR);

function refusal(benchmarkRecord: BenchmarkRecord, runRecord: RunRecord): BenchmarkProductError {
  try {
    assertTaskSelectionConsistency({ benchmarkRecord, runRecord });
  } catch (error) {
    return error as BenchmarkProductError;
  }
  return expect.unreachable("expected a refusal");
}

describe("declaredTaskSelectionMode", () => {
  test("reads a declared mode and reports an undeclared Run as undefined", () => {
    expect(declaredTaskSelectionMode(run({ mode: "claimant-chosen" }))).toBe("claimant-chosen");
    expect(declaredTaskSelectionMode(run())).toBeUndefined();
  });

  test("refuses bytes the Run schema would not have sealed, as a typed record refusal", () => {
    const error = (() => {
      try {
        declaredTaskSelectionMode(run({ mode: "whatever-i-like" }));
      } catch (cause) {
        return cause as BenchmarkProductError;
      }
      return expect.unreachable("expected a refusal");
    })();
    expect(error).toBeInstanceOf(BenchmarkProductError);
    expect(error.code).toBe("record-integrity");
    expect(error.issues[0]?.path).toBe("claim-consistency");
  });
});

describe("what nothing can contradict", () => {
  test("an undeclared Run passes — there is no claim to contradict", () => {
    expect(() => assertTaskSelectionConsistency({ benchmarkRecord: IMMEDIATE, runRecord: run() })).not.toThrow();
  });

  test("claimant-chosen passes even when the claimant authored the bank", () => {
    // The blunt value asserts nothing about anyone else, so nothing can contradict it. Constraining
    // it would only make the honest answer the expensive one.
    const self = benchmark({ policy: "immediate" }, CLAIMANT);
    expect(() => assertTaskSelectionConsistency({
      benchmarkRecord: self,
      runRecord: run({ mode: "claimant-chosen" }),
    })).not.toThrow();
  });
});

describe("a claimant-authored item bank", () => {
  const selfAuthored = benchmark({ policy: "immediate" }, CLAIMANT);

  test("contradicts fixed-public-set", () => {
    const error = refusal(selfAuthored, run({ mode: "fixed-public-set" }));
    expect(error.code).toBe("record-integrity");
    expect(error.message).toContain("the claimant authored the Benchmark record");
  });

  test("contradicts drawn-post-lock", () => {
    const withheld = benchmark({ policy: "after-run" }, CLAIMANT);
    expect(refusal(withheld, run({ mode: "drawn-post-lock" })).message)
      .toContain("the claimant authored the Benchmark record");
  });

  test("an absent author cannot support either stronger mode", () => {
    // Absence is not neutral here: the records simply do not name anyone else who chose.
    for (const mode of ["fixed-public-set", "drawn-post-lock"] as const) {
      expect(refusal(benchmark({ policy: mode === "drawn-post-lock" ? "after-run" : "immediate" }), run({ mode })).message)
        .toContain("names no author");
    }
  });
});

describe("reveal timing against the lock", () => {
  test("fixed-public-set accepts an immediately revealed set", () => {
    expect(() => assertTaskSelectionConsistency({
      benchmarkRecord: IMMEDIATE,
      runRecord: run({ mode: "fixed-public-set" }),
    })).not.toThrow();
  });

  test("fixed-public-set accepts a schedule that opened at or before the lock", () => {
    for (const notBefore of ["2026-08-19T00:00:00Z", LOCK]) {
      expect(() => assertTaskSelectionConsistency({
        benchmarkRecord: benchmark({ policy: "scheduled", notBefore }, CURATOR),
        runRecord: run({ mode: "fixed-public-set" }),
      })).not.toThrow();
    }
  });

  test("fixed-public-set refuses a set still withheld at the lock", () => {
    expect(refusal(AFTER_RUN, run({ mode: "fixed-public-set" })).message)
      .toContain("withholds its items until after the run was locked");
    expect(refusal(benchmark({ policy: "scheduled", notBefore: "2026-08-21T00:00:00Z" }, CURATOR), run({ mode: "fixed-public-set" })).message)
      .toContain("withholds its items until after the run was locked");
  });

  test("a schedule with no notBefore names no moment, so it cannot establish public-by-lock", () => {
    expect(refusal(benchmark({ policy: "scheduled" }, CURATOR), run({ mode: "fixed-public-set" })).message)
      .toContain("withholds its items until after the run was locked");
  });

  test("drawn-post-lock accepts an after-run reveal and a schedule opening after the lock", () => {
    expect(() => assertTaskSelectionConsistency({
      benchmarkRecord: AFTER_RUN,
      runRecord: run({ mode: "drawn-post-lock" }),
    })).not.toThrow();
    expect(() => assertTaskSelectionConsistency({
      benchmarkRecord: benchmark({ policy: "scheduled", notBefore: "2026-08-21T00:00:00Z" }, CURATOR),
      runRecord: run({ mode: "drawn-post-lock" }),
    })).not.toThrow();
  });

  test("drawn-post-lock refuses items the claimant could already read when locking", () => {
    expect(refusal(IMMEDIATE, run({ mode: "drawn-post-lock" })).message)
      .toContain("already revealed when the run was locked");
  });

  test("compares instants, not strings, so a differing UTC offset does not decide the check", () => {
    // 2026-08-19T20:00:00-05:00 is 2026-08-20T01:00:00Z — after the lock, though it sorts before it.
    expect(refusal(
      benchmark({ policy: "scheduled", notBefore: "2026-08-19T20:00:00-05:00" }, CURATOR),
      run({ mode: "fixed-public-set" }),
    ).message).toContain("withholds its items until after the run was locked");
  });
});
