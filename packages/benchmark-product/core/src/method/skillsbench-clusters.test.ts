import { describe, expect, it } from "vitest";
import {
  SKILLSBENCH_CLUSTER_EDGE_CLASSES,
  SKILLSBENCH_CLUSTER_POLICY,
  deriveSkillsBenchClusters,
  skillsBenchClusterId,
  skillsBenchClusterOf,
  verifySkillsBenchClusterGraph,
  type SkillsBenchClusterInput,
} from "./skillsbench-clusters.js";

function unit(taskId: string, overrides: Partial<SkillsBenchClusterInput> = {}): SkillsBenchClusterInput {
  return {
    taskId,
    skillContentDigests: [],
    inputFamilyDigests: [],
    taskLineageIds: [],
    verificationDigests: [],
    ...overrides,
  };
}

describe("independence clusters", () => {
  it("leaves independent units as singletons", () => {
    const graph = deriveSkillsBenchClusters([unit("a"), unit("b"), unit("c")]);
    expect(graph.clusters).toHaveLength(3);
    expect(graph.edges).toHaveLength(0);
  });

  it("joins two units that share a skill content digest", () => {
    const graph = deriveSkillsBenchClusters([
      unit("a", { skillContentDigests: ["s1"] }),
      unit("b", { skillContentDigests: ["s1"] }),
      unit("c", { skillContentDigests: ["s2"] }),
    ]);
    expect(graph.clusters).toHaveLength(2);
    expect(graph.clusters.find((c) => c.members.includes("a"))!.members).toEqual(["a", "b"]);
  });

  it("closes transitively across different edge classes", () => {
    // a–b by shared skill, b–c by shared dataset. All three are one cluster, which is the whole
    // point: a chain of dependence is dependence.
    const graph = deriveSkillsBenchClusters([
      unit("a", { skillContentDigests: ["s1"] }),
      unit("b", { skillContentDigests: ["s1"], inputFamilyDigests: ["d1"] }),
      unit("c", { inputFamilyDigests: ["d1"] }),
    ]);
    expect(graph.clusters).toHaveLength(1);
    expect(graph.clusters[0]!.members).toEqual(["a", "b", "c"]);
  });

  it("closes transitively through a long chain", () => {
    const graph = deriveSkillsBenchClusters([
      unit("a", { skillContentDigests: ["s1"] }),
      unit("b", { skillContentDigests: ["s1", "s2"] }),
      unit("c", { skillContentDigests: ["s2", "s3"] }),
      unit("d", { skillContentDigests: ["s3"] }),
      unit("e", { skillContentDigests: ["s9"] }),
    ]);
    expect(graph.clusters).toHaveLength(2);
    expect(graph.clusters.find((c) => c.members.includes("a"))!.members).toEqual(["a", "b", "c", "d"]);
  });

  it("records every pair with its evidence, not just a spanning set", () => {
    const graph = deriveSkillsBenchClusters([
      unit("a", { skillContentDigests: ["s1"] }),
      unit("b", { skillContentDigests: ["s1"] }),
      unit("c", { skillContentDigests: ["s1"] }),
    ]);
    expect(graph.edges).toHaveLength(3);
    for (const edge of graph.edges) {
      expect(edge.edgeClass).toBe("shared-skill-content");
      expect(edge.sharedIdentity).toBe("s1");
    }
  });

  it("names each of the four fixed edge classes", () => {
    const graph = deriveSkillsBenchClusters([
      unit("a", { skillContentDigests: ["s"], inputFamilyDigests: ["d"], taskLineageIds: ["t"], verificationDigests: ["v"] }),
      unit("b", { skillContentDigests: ["s"], inputFamilyDigests: ["d"], taskLineageIds: ["t"], verificationDigests: ["v"] }),
    ]);
    expect([...new Set(graph.edges.map((e) => e.edgeClass))].sort()).toEqual([...SKILLSBENCH_CLUSTER_EDGE_CLASSES].sort());
  });

  it("derives stable cluster ids from membership alone", () => {
    expect(skillsBenchClusterId(["b", "a"])).toBe(skillsBenchClusterId(["a", "b"]));
    expect(skillsBenchClusterId(["a", "b"])).not.toBe(skillsBenchClusterId(["a", "c"]));
    expect(skillsBenchClusterId(["a"])).toMatch(/^cluster:[0-9a-f]{32}$/u);
  });

  it("is deterministic across input orderings", () => {
    const inputs = [
      unit("a", { skillContentDigests: ["s1"] }),
      unit("b", { skillContentDigests: ["s1"] }),
      unit("c", { inputFamilyDigests: ["d1"] }),
      unit("d", { inputFamilyDigests: ["d1"] }),
    ];
    const forward = deriveSkillsBenchClusters(inputs);
    const reverse = deriveSkillsBenchClusters([...inputs].reverse());
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });

  it("indexes every unit to exactly one cluster", () => {
    const graph = deriveSkillsBenchClusters([unit("a", { skillContentDigests: ["s"] }), unit("b", { skillContentDigests: ["s"] }), unit("c")]);
    const index = skillsBenchClusterOf(graph);
    expect(index.size).toBe(3);
    expect(index.get("a")).toBe(index.get("b"));
    expect(index.get("c")).not.toBe(index.get("a"));
  });

  it("refuses duplicate task ids", () => {
    expect(() => deriveSkillsBenchClusters([unit("a"), unit("a")])).toThrow(/duplicate taskId/u);
  });

  describe("verification", () => {
    it("accepts a derived graph", () => {
      const graph = deriveSkillsBenchClusters([unit("a", { skillContentDigests: ["s"] }), unit("b", { skillContentDigests: ["s"] })]);
      expect(() => verifySkillsBenchClusterGraph(graph)).not.toThrow();
      expect(graph.policy).toBe(SKILLSBENCH_CLUSTER_POLICY);
    });

    it("refuses a graph whose clusters were split to fake independence", () => {
      const graph = deriveSkillsBenchClusters([unit("a", { skillContentDigests: ["s"] }), unit("b", { skillContentDigests: ["s"] })]);
      const split = {
        ...graph,
        clusters: [
          { clusterId: skillsBenchClusterId(["a"]), members: ["a"] },
          { clusterId: skillsBenchClusterId(["b"]), members: ["b"] },
        ],
      };
      expect(() => verifySkillsBenchClusterGraph(split)).toThrow(/crosses a cluster boundary/u);
    });

    it("refuses a graph with a hand-edited cluster id", () => {
      const graph = deriveSkillsBenchClusters([unit("a"), unit("b")]);
      const forged = { ...graph, clusters: [{ ...graph.clusters[0]!, clusterId: "cluster:" + "0".repeat(32) }, graph.clusters[1]!] };
      expect(() => verifySkillsBenchClusterGraph(forged)).toThrow(/does not recompute/u);
    });

    it("refuses a graph that dropped one of the four fixed edge classes", () => {
      const graph = deriveSkillsBenchClusters([unit("a")]);
      const weakened = { ...graph, edgeClasses: ["shared-skill-content"] as never };
      expect(() => verifySkillsBenchClusterGraph(weakened)).toThrow(/dropped the fixed edge class/u);
    });
  });
});
