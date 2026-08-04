import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldPolicyOutcomes, projectPolicyOutcomes } from "./projection.js";
import { PolicyOutcomesInputError } from "./observation.js";
import type { PolicyOutcomeObservation } from "./observation.js";

const observations = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/observations-golden.json", import.meta.url)), "utf8"),
) as PolicyOutcomeObservation[];

describe("foldPolicyOutcomes", () => {
  it("with no previous projection equals projectPolicyOutcomes", () => {
    expect(foldPolicyOutcomes(undefined, observations)).toEqual(projectPolicyOutcomes(observations));
  });

  it("folding in two batches equals projecting the union", () => {
    const first = observations.slice(0, 4);
    const rest = observations.slice(4);
    expect(foldPolicyOutcomes(projectPolicyOutcomes(first), rest)).toEqual(
      projectPolicyOutcomes(observations),
    );
  });

  it("is associative across three batches", () => {
    const [a, b, c] = [observations.slice(0, 3), observations.slice(3, 6), observations.slice(6)];
    const stepwise = foldPolicyOutcomes(foldPolicyOutcomes(projectPolicyOutcomes(a), b), c);
    expect(stepwise).toEqual(projectPolicyOutcomes(observations));
  });

  it("is idempotent under at-least-once redelivery", () => {
    const once = projectPolicyOutcomes(observations);
    expect(foldPolicyOutcomes(once, observations)).toEqual(once);
    expect(foldPolicyOutcomes(once, [...observations, ...observations])).toEqual(once);
  });

  it("round-trips a projection unchanged when nothing new arrives", () => {
    const projection = projectPolicyOutcomes(observations);
    expect(foldPolicyOutcomes(projection, [])).toEqual(projection);
  });

  it("recovers the fail, inconclusive, and per-axis pinning counters from a previous projection", () => {
    const organic = observations.filter((o) => o.benchmarkRun === undefined);
    const seedBatch = organic.slice(0, 2);
    const tail = organic.slice(2);
    const folded = foldPolicyOutcomes(projectPolicyOutcomes(seedBatch), tail).rows;
    const direct = projectPolicyOutcomes([...seedBatch, ...tail]).rows;
    expect(folded).toEqual(direct);
  });

  it("opens a new bucket row mid-fold", () => {
    const organic = observations.filter((o) => o.benchmarkRun === undefined);
    const pinned = observations.filter((o) => o.benchmarkRun !== undefined);
    const folded = foldPolicyOutcomes(projectPolicyOutcomes(organic), pinned);
    expect(folded).toEqual(projectPolicyOutcomes(observations));
  });

  // Idempotent under exact redelivery -- the same announcement, same everything.
  it("accepts an exact redelivery as a no-op", () => {
    const [first] = observations;
    const once = projectPolicyOutcomes([first]);
    expect(foldPolicyOutcomes(once, [first])).toEqual(once);
  });

  // A conflicting redelivery -- same dedupe key, disagreeing content -- is refused, never
  // last-write-wins (substrate §6.2). Both observations are fresh in the SAME fold call (as in
  // curation's own `projection.test.ts`), so the accumulator's `SeenAnnouncement` carries the
  // full observation and can compare every field, not just the ref.
  it("refuses two observations sharing a dedupe key but disagreeing on verdict, in either order", () => {
    const [first] = observations;
    const conflicting = { ...first, verdict: "fail" as const };
    expect(() => projectPolicyOutcomes([first, conflicting])).toThrow(PolicyOutcomesInputError);
    expect(() => projectPolicyOutcomes([conflicting, first])).toThrow(PolicyOutcomesInputError);
  });

  it("refuses two observations sharing a dedupe key but disagreeing on perAxisStatus", () => {
    const [first] = observations;
    const conflicting = {
      ...first,
      perAxisStatus: { ...first.perAxisStatus, harness: "mismatch" as const },
    };
    expect(() => projectPolicyOutcomes([first, conflicting])).toThrow(PolicyOutcomesInputError);
  });

  it("refuses two observations sharing a dedupe key but disagreeing on taskDigest", () => {
    const [first] = observations;
    const conflicting = { ...first, taskDigest: `sha256:${"9".repeat(64)}` as const };
    expect(() => projectPolicyOutcomes([first, conflicting])).toThrow(PolicyOutcomesInputError);
  });

  // Against a PREVIOUS PROJECTION (stored state), only ref agreement is checkable -- the
  // projection retains each ref but not the observation behind it (mirrors curation's documented
  // closure). A same-ref redelivery with a different verdict is therefore accepted as a no-op at
  // this boundary; the announcement-level conflict check above is what actually gates it.
  it("against stored state, only ref agreement is checkable (documented closure, not a gap in THIS test)", () => {
    const [first] = observations;
    const stored = projectPolicyOutcomes([first]);
    const sameRefDifferentRow = { ...first, verdict: "fail" as const };
    // Same ref, so it is recognized as "the same announcement" and re-applying it is a no-op:
    // the fold never sees the conflicting verdict because ref identity alone is what's stored.
    expect(foldPolicyOutcomes(stored, [sameRefDifferentRow])).toEqual(stored);
  });

  it("rejects a previous projection whose rows violate the row invariant", () => {
    const bareRow = {
      rows: [
        {
          tupleDigest: "not-a-digest",
          axes: {},
          bucket: "organic",
          attempts: 0,
          verdicts: 1_000_000,
          passRate: { num: 999_999, den: 1_000_000 },
          pinning: {
            harness: { match: 0, mismatch: 0, unverifiable: 0 },
            model: { match: 0, mismatch: 0, unverifiable: 0 },
            loadout: { match: 0, mismatch: 0, unverifiable: 0 },
            isolationPolicy: { match: 0, mismatch: 0, unverifiable: 0 },
          },
          window: { first: "2026-07-31T00:00:00Z", last: "2026-07-31T01:00:00Z" },
          inputRefs: [],
        },
      ],
    };
    expect(() => foldPolicyOutcomes(bareRow as never, [])).toThrow(PolicyOutcomesInputError);
  });

  it("rejects a previous projection whose counters contradict its inputRefs", () => {
    const previous = projectPolicyOutcomes(observations);
    const tampered = {
      rows: previous.rows.map((row) => ({ ...row, inputRefs: row.inputRefs.slice(1) })),
    };
    expect(() => foldPolicyOutcomes(tampered as never, [])).toThrow(PolicyOutcomesInputError);
  });

  it("rejects a previous projection whose pinning counters do not sum to verdicts", () => {
    const previous = projectPolicyOutcomes(observations);
    const tampered = {
      rows: previous.rows.map((row) => ({
        ...row,
        pinning: { ...row.pinning, harness: { match: 999, mismatch: 0, unverifiable: 0 } },
      })),
    };
    expect(() => foldPolicyOutcomes(tampered as never, [])).toThrow(PolicyOutcomesInputError);
  });
});
