import { describe, expect, it } from "vitest";
import {
  SKILLSBENCH_PARTITION_POLICY,
  partitionSkillsBenchPools,
  verifySkillsBenchPartition,
  type SkillsBenchPartitionUnit,
} from "./skillsbench-partition.js";

/** `clusters` cluster ids, `perCluster` units in each. */
function units(clusters: number, perCluster = 1): SkillsBenchPartitionUnit[] {
  const rows: SkillsBenchPartitionUnit[] = [];
  for (let c = 0; c < clusters; c += 1) {
    for (let u = 0; u < perCluster; u += 1) {
      const taskId = `c${String(c).padStart(2, "0")}-u${u}`;
      rows.push({ taskId, clusterId: `cluster:${String(c).padStart(2, "0")}`, unitDigest: `sha256:${taskId}` });
    }
  }
  return rows;
}

const SEED = 486786042;

describe("cluster-indivisible partition", () => {
  it("fills all three pools from a viable inventory", () => {
    const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
    expect(partition.policy).toBe(SKILLSBENCH_PARTITION_POLICY);
    expect(partition.suitability).toHaveLength(6);
    expect(partition.rehearsal).toHaveLength(10);
    expect(partition.officialFeasibility).toHaveLength(5);
    expect(() => verifySkillsBenchPartition(partition)).not.toThrow();
  });

  it("keeps the three pools cluster-disjoint", () => {
    // The property clustering exists for: a unit dependent on one in another pool would leak.
    const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
    const set = (rows: typeof partition.suitability) => new Set(rows.map((u) => u.clusterId));
    const [s, r, o] = [set(partition.suitability), set(partition.rehearsal), set(partition.officialFeasibility)];
    for (const cluster of s) expect(r.has(cluster) || o.has(cluster)).toBe(false);
    for (const cluster of r) expect(o.has(cluster)).toBe(false);
  });

  it("spans six distinct clusters in suitability, one unit each", () => {
    const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
    expect(new Set(partition.suitability.map((u) => u.clusterId)).size).toBe(6);
  });

  it("spans at least five clusters in rehearsal", () => {
    const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
    expect(new Set(partition.rehearsal.map((u) => u.clusterId)).size).toBeGreaterThanOrEqual(5);
  });

  it("is deterministic for the same seed and inventory", () => {
    const a = partitionSkillsBenchPools(units(34, 2), SEED)!;
    const b = partitionSkillsBenchPools([...units(34, 2)].reverse(), SEED)!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("changes with the seed", () => {
    const a = partitionSkillsBenchPools(units(34, 2), SEED)!;
    const b = partitionSkillsBenchPools(units(34, 2), SEED + 1)!;
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("never places a unit in two pools", () => {
    const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
    const ids = [...partition.suitability, ...partition.rehearsal, ...partition.officialFeasibility].map((u) => u.taskId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves the remaining official-cluster units in a frozen order", () => {
    const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
    expect(partition.officialOrder.length).toBeGreaterThanOrEqual(partition.officialFeasibility.length);
    const ranks = partition.officialOrder.map((u) => u.selectionRankSha256);
    expect([...ranks].sort()).toEqual(ranks);
  });

  describe("refusals", () => {
    it("returns null below the combined cluster floor", () => {
      // 6 + 5 + 2 = 13 clusters minimum. Twelve cannot fill three disjoint pools.
      expect(partitionSkillsBenchPools(units(12, 5), SEED)).toBeNull();
    });

    it("returns null when rehearsal cannot reach ten units", () => {
      // 13 clusters but one unit each: rehearsal's five clusters can only supply five units.
      expect(partitionSkillsBenchPools(units(13, 1), SEED)).toBeNull();
    });

    it("succeeds at exactly the floor when depth allows", () => {
      const partition = partitionSkillsBenchPools(units(13, 3), SEED);
      expect(partition).not.toBeNull();
      expect(() => verifySkillsBenchPartition(partition!)).not.toThrow();
    });
  });

  describe("verification", () => {
    it("refuses a pool that lost a unit", () => {
      const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
      const short = { ...partition, suitability: partition.suitability.slice(1) };
      expect(() => verifySkillsBenchPartition(short)).toThrow(/holds 5 units; the floor is 6/u);
    });

    it("refuses pools that were made to overlap", () => {
      const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
      const overlapped = { ...partition, rehearsal: [...partition.rehearsal.slice(1), partition.suitability[0]!] };
      expect(() => verifySkillsBenchPartition(overlapped)).toThrow(/share cluster/u);
    });

    it("refuses a suitability pool collapsed onto fewer clusters", () => {
      const partition = partitionSkillsBenchPools(units(34, 2), SEED)!;
      const collapsed = {
        ...partition,
        suitability: partition.suitability.map((u) => ({ ...u, clusterId: partition.suitability[0]!.clusterId })),
      };
      expect(() => verifySkillsBenchPartition(collapsed)).toThrow(/spans 1 clusters/u);
    });
  });
});
