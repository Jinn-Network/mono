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

  test("claimant-chosen passes under every reveal policy and either authorship", () => {
    // The blunt value asserts nothing about anyone else, so nothing can contradict it. Constraining
    // it would only make the honest answer the expensive one.
    for (const benchmarkRecord of [IMMEDIATE, AFTER_RUN, benchmark({ policy: "immediate" }, CLAIMANT), benchmark({ policy: "immediate" })]) {
      expect(() => assertTaskSelectionConsistency({
        benchmarkRecord,
        runRecord: run({ mode: "claimant-chosen" }),
      })).not.toThrow();
    }
  });
});

describe("what the verifier deliberately does not decide", () => {
  test("a self-authored bank does not by itself refuse either stronger mode", () => {
    // `author` is a self-declaration the design spec marks non-authoritative, and every task-set
    // intake in this product re-authors the Benchmark under the workspace key that is also the Run
    // owner. Refusing on `author === owner` would make two of the three vocabulary values dead
    // letters — and would do it AFTER the lock, on a bundle the workspace can never publish.
    expect(() => assertTaskSelectionConsistency({
      benchmarkRecord: benchmark({ policy: "immediate" }, CLAIMANT),
      runRecord: run({ mode: "fixed-public-set", owner: CLAIMANT }),
    })).not.toThrow();
    expect(() => assertTaskSelectionConsistency({
      benchmarkRecord: benchmark({ policy: "after-run" }, CLAIMANT),
      runRecord: run({ mode: "drawn-post-lock", owner: CLAIMANT }),
    })).not.toThrow();
  });

  test("a schedule opening mid-run is not decided either way, because closeAt is not the lock", () => {
    // closeAt = lockedAt + closeAfterMs (strictly positive, 24h by default), and no bundle carries
    // lockedAt. A notBefore before closeAt therefore proves nothing about the lock, so neither mode
    // is refused on it.
    const midRun = benchmark({ policy: "scheduled", notBefore: "2026-08-19T12:00:00Z" }, CURATOR);
    for (const mode of ["fixed-public-set", "drawn-post-lock"] as const) {
      expect(() => assertTaskSelectionConsistency({ benchmarkRecord: midRun, runRecord: run({ mode }) })).not.toThrow();
    }
  });
});

describe("fixed-public-set", () => {
  test("accepts an immediately revealed, authored set", () => {
    expect(() => assertTaskSelectionConsistency({
      benchmarkRecord: IMMEDIATE,
      runRecord: run({ mode: "fixed-public-set" }),
    })).not.toThrow();
  });

  test("refuses a set nobody declared", () => {
    expect(refusal(benchmark({ policy: "immediate" }), run({ mode: "fixed-public-set" })).message)
      .toContain("names no author");
  });

  test("refuses items provably still withheld when the run was locked", () => {
    expect(refusal(AFTER_RUN, run({ mode: "fixed-public-set" })).message)
      .toContain("withholds its items past the end of the run");
    // notBefore at or after closeAt is after the lock too, since the lock strictly precedes close.
    for (const notBefore of [LOCK, "2026-08-21T00:00:00Z"]) {
      expect(refusal(benchmark({ policy: "scheduled", notBefore }, CURATOR), run({ mode: "fixed-public-set" })).message)
        .toContain("withholds its items past the end of the run");
    }
  });

  test("refuses a leap-second notBefore rather than failing open on an unparseable date", () => {
    // `isCalendarStrictRfc3339` accepts leap seconds and `Date.parse` returns NaN for them, so a
    // naive `>=` would return false and wave this through. The claimant controls `notBefore`, so
    // that would have been a one-spelling bypass of the only check that makes fixed-public-set a
    // claim rather than a label.
    expect(refusal(
      benchmark({ policy: "scheduled", notBefore: "2026-12-31T23:59:60Z" }, CURATOR),
      run({ mode: "fixed-public-set" }),
    ).message).toContain("withholds its items past the end of the run");
  });

  test("compares instants, not strings, so a differing UTC offset does not decide the check", () => {
    // 2026-08-19T20:00:00-05:00 is 2026-08-20T01:00:00Z — at or after closeAt, though it sorts before.
    expect(refusal(
      benchmark({ policy: "scheduled", notBefore: "2026-08-19T20:00:00-05:00" }, CURATOR),
      run({ mode: "fixed-public-set" }),
    ).message).toContain("withholds its items past the end of the run");
  });
});

describe("drawn-post-lock", () => {
  test("accepts a withheld set, scheduled or after-run", () => {
    for (const benchmarkRecord of [
      AFTER_RUN,
      benchmark({ policy: "scheduled", notBefore: "2026-08-21T00:00:00Z" }, CURATOR),
      benchmark({ policy: "scheduled" }, CURATOR),
    ]) {
      expect(() => assertTaskSelectionConsistency({
        benchmarkRecord,
        runRecord: run({ mode: "drawn-post-lock" }),
      })).not.toThrow();
    }
  });

  test("refuses items the claimant could already read when the run was locked", () => {
    expect(refusal(IMMEDIATE, run({ mode: "drawn-post-lock" })).message)
      .toContain("reveals its items immediately");
  });

  test("does not require an author — a drawn set need not have been declared to anyone", () => {
    expect(() => assertTaskSelectionConsistency({
      benchmarkRecord: benchmark({ policy: "after-run" }),
      runRecord: run({ mode: "drawn-post-lock" }),
    })).not.toThrow();
  });
});
