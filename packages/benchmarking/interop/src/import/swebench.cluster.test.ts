import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBenchmarkTaskProvenance } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { importSweBench, type SweBenchRow } from "./swebench.js";

const ROWS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/swebench/rows.multi-repo.json", import.meta.url)), "utf8"),
) as SweBenchRow[];

const OPTS = {
  name: "cluster regression",
  description: "Three instances across two source repos.",
  version: "1.0.0",
  provenanceTimestamp: "2026-07-29T00:00:00Z",
};

function clusterValues() {
  const imported = importSweBench(ROWS, OPTS);
  const byDigest = new Map(imported.tasks.map((task) => [task.digest, task.bytes]));
  return imported.tasks.map((task) => {
    const resolved = resolveBenchmarkTaskProvenance(task.digest, (digest) => byDigest.get(digest as `sha256:${string}`));
    if (!resolved.ok) throw new Error(`provenance did not resolve: ${resolved.reason}`);
    return resolved.provenance.cluster.value;
  });
}

describe("SWE-bench import — provenance clusters group by source repo", () => {
  test("three instances across two repos yield TWO clusters, not three", () => {
    // The defect this pins: with `@<base_commit>` in the source, every SWE instance is its own
    // singleton cluster, so the clustered bootstrap's between-repo correction never fires. Measured
    // on 100 real leaderboard rows: 100 distinct source keys against 77 distinct repos, zero
    // collisions. Two of these three rows are the same repo at different commits.
    expect(new Set(clusterValues()).size).toBe(2);
  });

  test("the cluster key is the repository, carrying no commit", () => {
    const values = [...new Set(clusterValues())].sort();
    expect(values).toEqual([
      "https://github.com/astropy/astropy",
      "https://github.com/psf/requests",
    ]);
    for (const value of values) expect(value).not.toContain("@");
  });

  test("tasks stay distinct even though their clusters merge", () => {
    // base_commit remains task identity — it is preserved losslessly in the Task's inputs
    // (`taskInputs[0].annotations.ref`, profiles/src/documents/swe-rebench.ts:81-85) and in
    // `payload.instance_id`. Merging clusters must never merge tasks.
    const imported = importSweBench(ROWS, OPTS);
    expect(new Set(imported.tasks.map((task) => task.digest)).size).toBe(3);
  });

  test("every imported task still passes judgeability", () => {
    const imported = importSweBench(ROWS, OPTS);
    expect(imported.benchmark.record.items).toHaveLength(3);
  });
});

describe("SWE-bench import — per-instance provenance timestamps", () => {
  test("stamps each instance with its own timestamp when supplied", () => {
    const imported = importSweBench(ROWS, {
      ...OPTS,
      provenanceTimestamps: {
        "swe-rebench-cluster-00001": "2026-01-03T00:00:00Z",
        "swe-rebench-cluster-00002": "2026-02-14T00:00:00Z",
      },
    });
    const byDigest = new Map(imported.tasks.map((task) => [task.digest, task.bytes]));
    const timestamps = imported.tasks.map((task) => {
      const resolved = resolveBenchmarkTaskProvenance(task.digest, (digest) =>
        byDigest.get(digest as `sha256:${string}`));
      if (!resolved.ok) throw new Error(`provenance did not resolve: ${resolved.reason}`);
      return resolved.provenance.timestamp;
    });
    // Two overridden, the third falling back to the batch value. Without this, clean-subset@1's
    // per-task contamination predicate collapses to one importer-chosen global boolean — whoever
    // runs the import can pick a date late enough to retain 100% of any slate as "clean".
    expect(new Set(timestamps).size).toBe(3);
    expect(timestamps).toContain("2026-01-03T00:00:00Z");
    expect(timestamps).toContain("2026-02-14T00:00:00Z");
    expect(timestamps).toContain("2026-07-29T00:00:00Z");
  });

  test("omitting the map leaves the default path byte-identical", () => {
    // intake/swebench.test.ts's determinism assertions depend on this.
    const first = importSweBench(ROWS, OPTS);
    const second = importSweBench(ROWS, OPTS);
    expect(second.tasks.map((task) => task.digest)).toEqual(first.tasks.map((task) => task.digest));
    expect(second.benchmark.digest).toBe(first.benchmark.digest);
  });
});

describe("SWE-bench import — the batch timestamp is validated at the same edge", () => {
  test("repairs the timestamp shapes upstream datasets actually ship", () => {
    // A bare date is what upstream datasets emit; the per-instance path already repaired it, so
    // the batch option carrying the identical value must not fail instead.
    const bareDate = importSweBench(ROWS, { ...OPTS, provenanceTimestamp: "2026-01-03" });
    const spaced = importSweBench(ROWS, { ...OPTS, provenanceTimestamp: "2026-01-03 00:00:00" });
    const explicit = importSweBench(ROWS, { ...OPTS, provenanceTimestamp: "2026-01-03T00:00:00Z" });
    // Digest equality, not just a resolved string: the repair must produce the SAME sealed bytes
    // the already-normalized value produces, or content addressing forks on input formatting.
    expect(bareDate.benchmark.digest).toBe(explicit.benchmark.digest);
    expect(spaced.benchmark.digest).toBe(explicit.benchmark.digest);
  });

  test("a malformed batch timestamp names the offending value, not a task digest", () => {
    // Left to checkJudgeability, this surfaces as `invalid-provenance` against a digest, naming
    // neither the option nor the bad value — the digest-hunt the per-instance path was fixed to
    // avoid.
    expect(() => importSweBench(ROWS, { ...OPTS, provenanceTimestamp: "2026-02-30" }))
      .toThrow(/^provenanceTimestamp: timestamp "2026-02-30" cannot be converted/u);
  });

  test("the batch value is refused even when every row carries an override", () => {
    // The batch conversion runs once, before the row loop, so it fails fast on a value that no row
    // would have read. Deliberate: the option is documented as the per-instance fallback, and a
    // malformed fallback is a defect whether or not this particular slate happens to cover it.
    expect(() =>
      importSweBench(ROWS, {
        ...OPTS,
        provenanceTimestamp: "2026-02-30",
        provenanceTimestamps: Object.fromEntries(
          ROWS.map((row) => [row.instance_id, "2026-01-03T00:00:00Z"]),
        ),
      }),
    ).toThrow(/^provenanceTimestamp: /u);
  });
});

describe("SWE-bench import — per-instance timestamps are validated at the edge", () => {
  test("repairs the timestamp shapes upstream datasets actually ship", () => {
    const imported = importSweBench(ROWS, {
      ...OPTS,
      provenanceTimestamps: {
        "swe-rebench-cluster-00001": "2026-01-03",
        "swe-rebench-cluster-00002": "2026-02-14 09:30:00",
      },
    });
    const byDigest = new Map(imported.tasks.map((task) => [task.digest, task.bytes]));
    const timestamps = imported.tasks.map((task) => {
      const resolved = resolveBenchmarkTaskProvenance(task.digest, (digest) =>
        byDigest.get(digest as `sha256:${string}`));
      if (!resolved.ok) throw new Error(`provenance did not resolve: ${resolved.reason}`);
      return resolved.provenance.timestamp;
    });
    expect(timestamps).toContain("2026-01-03T00:00:00Z");
    expect(timestamps).toContain("2026-02-14T09:30:00Z");
  });

  test("a malformed timestamp names the offending instance, not a task digest", () => {
    // Left to checkJudgeability, this surfaces as `invalid-provenance` against a digest, naming
    // neither the instance nor the bad value — a digest-hunt on a large import.
    expect(() =>
      importSweBench(ROWS, {
        ...OPTS,
        provenanceTimestamps: { "swe-rebench-cluster-00002": "2026-02-30" },
      }),
    ).toThrow(/provenanceTimestamps\["swe-rebench-cluster-00002"\].*cannot be converted/u);
  });

  test("a malformed ROW is not mis-attributed to the timestamp map", () => {
    // The try must wrap only the conversion. Wrapping the seal too would prefix any row-shape
    // failure with `provenanceTimestamps[...]` — but only for rows carrying an override — pointing
    // an operator at their timestamp file to debug a bad image descriptor. That is the same
    // misdirection this validation exists to remove, inverted.
    const badRow = { ...ROWS[1]!, image: {} };
    const withOverride = () =>
      importSweBench([ROWS[0]!, badRow], {
        ...OPTS,
        provenanceTimestamps: { [badRow.instance_id]: "2026-02-14T00:00:00Z" },
      });
    const withoutOverride = () => importSweBench([ROWS[0]!, badRow], OPTS);

    expect(withOverride).toThrow();
    expect(withoutOverride).toThrow();
    // Both paths must report the SAME row-shape failure; the override path must not rename it.
    expect(withOverride).not.toThrow(/provenanceTimestamps/u);
  });

  test("an instance_id colliding with an Object.prototype member does not resolve a function", () => {
    const rows = [{ ...ROWS[0]!, instance_id: "toString" }];
    const imported = importSweBench(rows, { ...OPTS, provenanceTimestamps: {} });
    const resolved = resolveBenchmarkTaskProvenance(
      imported.tasks[0]!.digest,
      () => imported.tasks[0]!.bytes,
    );
    if (!resolved.ok) throw new Error(`provenance did not resolve: ${resolved.reason}`);
    expect(resolved.provenance.timestamp).toBe("2026-07-29T00:00:00Z");
  });
});
