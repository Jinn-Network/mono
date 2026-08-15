import { describe, expect, it } from "vitest";
import { projectCuration, type CurationRow } from "./projection.js";
import { CurationInputError } from "./observation.js";
import type { CurationObservation, ObservedVerdict } from "./observation.js";

let counter = 0;
function observation(
  verdict: ObservedVerdict,
  overrides: Partial<CurationObservation> = {},
): CurationObservation {
  counter += 1;
  const n = String(counter).padStart(4, "0");
  return {
    taskDigest: `sha256:${"c".repeat(64)}`,
    verdict,
    observedAt: `2026-07-31T0${(counter % 9) + 1}:00:00Z`,
    attribution: "urn:jinn:agent:solver-a",
    ref: {
      source: { agent: "https://spec.jinn.network/agents/projector", name: "base-marketplace" },
      entry: `sha256:${"a".repeat(60)}${n}`,
      announcementId: `ann-${n}`,
      record: `sha256:${"b".repeat(60)}${n}`,
      attemptUri: `urn:uuid:0189d1c2-0000-7000-8000-00000000${n}`,
    },
    ...overrides,
  };
}

describe("projectCuration", () => {
  it("returns no rows for no observations", () => {
    expect(projectCuration([])).toEqual({ rows: [] });
  });

  it("counts verdicts and expresses the observed pass rate as num over den", () => {
    const [row] = projectCuration([
      observation("pass"), observation("pass"), observation("fail"),
    ]).rows as CurationRow[];
    expect(row.verdicts).toBe(3);
    expect(row.passRate).toEqual({ num: 2, den: 3 });
  });

  it("excludes inconclusive verdicts from the denominator but not from the count", () => {
    const [row] = projectCuration([
      observation("pass"), observation("fail"), observation("inconclusive"),
    ]).rows;
    expect(row.verdicts).toBe(3);
    expect(row.passRate).toEqual({ num: 1, den: 2 });
    expect(row.verdicts - row.passRate.den).toBe(1); // inconclusive, recovered exactly
    expect(row.passRate.den - row.passRate.num).toBe(1); // fail, recovered exactly
  });

  it("counts distinct attempts, not verdicts", () => {
    const shared = "urn:uuid:0189d1c2-0000-7000-8000-0000000000ff";
    const rows = projectCuration([
      observation("pass", { ref: { ...observation("pass").ref, attemptUri: shared } }),
      observation("fail", { ref: { ...observation("fail").ref, attemptUri: shared } }),
    ]).rows;
    expect(rows[0].verdicts).toBe(2);
    expect(rows[0].attempts).toBe(1);
  });

  it("derives the window from observation timestamps only", () => {
    const rows = projectCuration([
      observation("pass", { observedAt: "2026-07-31T12:00:00Z" }),
      observation("pass", { observedAt: "2026-07-30T08:00:00Z" }),
      observation("fail", { observedAt: "2026-07-31T06:00:00Z" }),
    ]).rows;
    expect(rows[0].window).toEqual({ first: "2026-07-30T08:00:00Z", last: "2026-07-31T12:00:00Z" });
  });

  it("compares instants by value, not by string, across offsets", () => {
    const rows = projectCuration([
      observation("pass", { observedAt: "2026-07-31T10:00:00Z" }),
      observation("pass", { observedAt: "2026-07-31T04:00:00-07:00" }), // == 11:00:00Z
    ]).rows;
    expect(rows[0].window.last).toBe("2026-07-31T04:00:00-07:00");
  });

  it("splits rows by task digest and orders them deterministically", () => {
    const other = `sha256:${"e".repeat(64)}` as const;
    const rows = projectCuration([
      observation("pass", { taskDigest: other }),
      observation("pass"),
    ]).rows;
    expect(rows.map((r) => r.taskDigest)).toEqual([`sha256:${"c".repeat(64)}`, other]);
  });

  it("treats an exact redelivery of one announcement as a no-op", () => {
    const once = observation("pass");
    const [row] = projectCuration([once, { ...once, ref: { ...once.ref } }]).rows;
    expect(row.verdicts).toBe(1);
    expect(row.inputRefs).toHaveLength(1);
  });

  // Dropping the second silently would make the rate depend on arrival order, and the dropped
  // announcement would never appear in inputRefs -- the F6 failure mode in miniature.
  it("rejects two observations that share a dedupe key but disagree, in either order", () => {
    const first = observation("pass");
    const conflicting: CurationObservation = {
      ...first,
      verdict: "fail",
      ref: {
        ...first.ref,
        record: `sha256:${"5".repeat(64)}`,
        attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-0000000000ee",
      },
    };
    expect(() => projectCuration([first, conflicting])).toThrow(CurationInputError);
    expect(() => projectCuration([conflicting, first])).toThrow(CurationInputError);
  });

  it("rejects one announcement claiming two different subject tasks", () => {
    const first = observation("pass");
    const elsewhere: CurationObservation = { ...first, taskDigest: `sha256:${"e".repeat(64)}` };
    expect(() => projectCuration([first, elsewhere])).toThrow(CurationInputError);
    expect(() => projectCuration([elsewhere, first])).toThrow(CurationInputError);
  });

  it("rejects one announcement counted into two buckets", () => {
    const first = observation("pass");
    const pinned: CurationObservation = { ...first, benchmarkRun: `sha256:${"9".repeat(64)}` };
    expect(() => projectCuration([first, pinned])).toThrow(CurationInputError);
  });

  it("rejects a malformed observation rather than skipping it", () => {
    expect(() => projectCuration([{ ...observation("pass"), observedAt: "yesterday" } as never]))
      .toThrow(/observation/i);
  });

  // Constraint 16: bare-rate-free by construction.
  it("exposes exactly the pinned keys and no float anywhere", () => {
    const [row] = projectCuration([observation("pass"), observation("fail")]).rows;
    expect(Object.keys(row).sort()).toEqual(
      ["attempts", "bucket", "inputRefs", "passRate", "taskDigest", "verdicts", "window"],
    );
    expect(Object.keys(row.passRate).sort()).toEqual(["den", "num"]);
    expect(Object.keys(row.window).sort()).toEqual(["first", "last"]);
    const numbers: number[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "number") numbers.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(row);
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.every((n) => Number.isInteger(n))).toBe(true);
  });

  // Success criterion 2.
  it("is order-independent across every permutation of its inputs", () => {
    const input = [
      observation("pass"), observation("fail"), observation("pass"),
      observation("inconclusive"), observation("fail"),
    ];
    const expected = JSON.stringify(projectCuration(input));
    const permute = (rest: CurationObservation[], prefix: CurationObservation[] = []): void => {
      if (rest.length === 0) {
        expect(JSON.stringify(projectCuration(prefix))).toBe(expected);
        return;
      }
      rest.forEach((item, index) => {
        permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...prefix, item]);
      });
    };
    permute(input); // 120 permutations
  });
});
