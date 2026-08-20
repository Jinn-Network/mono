import { describe, expect, it } from "vitest";
import type { SkillsBenchDemo1AdmittedCell } from "./skillsbench-demo1-declaration.js";
import { informativeSubset } from "./skillsbench-demo1-stats.js";

function cell(
  taskId: string,
  arm: SkillsBenchDemo1AdmittedCell["arm"],
  replicate: number,
  rewardValue: number,
): SkillsBenchDemo1AdmittedCell {
  return {
    cellId: `${taskId}/${arm}/r${replicate}`,
    section: "slate",
    taskId,
    arm,
    replicate,
    reward: String(rewardValue),
    rewardValue,
    fullPass: rewardValue === 1,
    baseImage: undefined,
  };
}

function task(id: string, a: number[], b: number[], c: number[]): SkillsBenchDemo1AdmittedCell[] {
  return [
    ...a.map((value, replicate) => cell(id, "A-native-skill", replicate, value)),
    ...b.map((value, replicate) => cell(id, "B-flat-claude-md", replicate, value)),
    ...c.map((value, replicate) => cell(id, "C-no-instructions", replicate, value)),
  ];
}

describe("Demo-1 informative subset", () => {
  it("keeps a task whose C replicates are all zero and some arm succeeds", () => {
    const cells = task("kept", [1, 0], [0, 0], [0, 0]);
    expect(informativeSubset(cells).map((entry) => entry.cellId)).toEqual(cells.map((entry) => entry.cellId));
  });

  it("drops a task with any nonzero C replicate", () => {
    const cells = [...task("kept", [1], [0], [0]), ...task("leak", [1], [1], [0, 1])];
    expect(new Set(informativeSubset(cells).map((entry) => entry.taskId))).toEqual(new Set(["kept"]));
  });

  it("drops a task where both A and B means are zero", () => {
    const cells = task("dead", [0, 0], [0, 0], [0, 0]);
    expect(informativeSubset(cells)).toEqual([]);
  });
});
