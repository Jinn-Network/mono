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
