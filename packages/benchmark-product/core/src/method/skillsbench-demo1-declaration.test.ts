import { describe, expect, it } from "vitest";
import {
  admitDeclaredCells,
  SKILLSBENCH_DEMO1_DECLARATION_SCHEMA,
  SkillsBenchDeclarationError,
  type SkillsBenchDemo1Declaration,
} from "./skillsbench-demo1-declaration.js";

const MODEL = "claude-haiku-4-5-20251001";

function declaration(overrides?: Partial<SkillsBenchDemo1Declaration>): SkillsBenchDemo1Declaration {
  return {
    schema: SKILLSBENCH_DEMO1_DECLARATION_SCHEMA,
    model: MODEL,
    slate: [
      { taskId: "alpha", expected: { "A-native-skill": 2, "B-flat-claude-md": 2, "C-no-instructions": 1 } },
      { taskId: "beta", expected: { "A-native-skill": 1, "B-flat-claude-md": 1 } },
    ],
    ...overrides,
  };
}

function cell(taskId: string, arm: string, replicate: number, reward: string | null, model = MODEL) {
  return { taskId, arm, replicate, model, reward, baseImage: "ubuntu@sha256:feed" };
}

/** A cells document holding exactly what the default declaration expects. */
function completeCells(): Record<string, ReturnType<typeof cell>> {
  return {
    "alpha/A-native-skill/r0": cell("alpha", "A-native-skill", 0, "1"),
    "alpha/A-native-skill/r1": cell("alpha", "A-native-skill", 1, "0"),
    "alpha/B-flat-claude-md/r0": cell("alpha", "B-flat-claude-md", 0, "1.000000"),
    "alpha/B-flat-claude-md/r1": cell("alpha", "B-flat-claude-md", 1, "0"),
    "alpha/C-no-instructions/r0": cell("alpha", "C-no-instructions", 0, "0"),
    "beta/A-native-skill/r0": cell("beta", "A-native-skill", 0, "0"),
    "beta/B-flat-claude-md/r0": cell("beta", "B-flat-claude-md", 0, "1"),
  };
}

describe("admitDeclaredCells", () => {
  it("admits a complete document and normalizes decimal rewards", () => {
    const admitted = admitDeclaredCells(declaration(), { cells: completeCells() });
    expect(admitted.cells).toHaveLength(7);
    const flat = admitted.cells.find((c) => c.cellId === "alpha/B-flat-claude-md/r0")!;
    expect(flat.fullPass).toBe(true);
    expect(admitted.cells.map((c) => c.cellId)).toEqual([...admitted.cells.map((c) => c.cellId)].sort());
  });

  it("throws listing every missing cell rather than shrinking the denominator", () => {
    const cells = completeCells();
    delete cells["alpha/A-native-skill/r1"];
    delete cells["beta/B-flat-claude-md/r0"];
    let caught: unknown;
    try {
      admitDeclaredCells(declaration(), { cells });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SkillsBenchDeclarationError);
    const problems = (caught as SkillsBenchDeclarationError).problems;
    expect(problems).toContain("missing cell alpha/A-native-skill/r1");
    expect(problems).toContain("missing cell beta/B-flat-claude-md/r0");
    expect(problems).toHaveLength(2);
  });

  it("throws on an unparseable reward", () => {
    const cells = completeCells();
    cells["alpha/C-no-instructions/r0"] = cell("alpha", "C-no-instructions", 0, "MISSING");
    expect(() => admitDeclaredCells(declaration(), { cells }))
      .toThrow(/unparseable reward alpha\/C-no-instructions\/r0/u);
  });

  it("throws on a null reward", () => {
    const cells = completeCells();
    cells["beta/A-native-skill/r0"] = cell("beta", "A-native-skill", 0, null);
    expect(() => admitDeclaredCells(declaration(), { cells }))
      .toThrow(SkillsBenchDeclarationError);
  });

  it("throws when a cell ran on the wrong model", () => {
    const cells = completeCells();
    cells["beta/A-native-skill/r0"] = cell("beta", "A-native-skill", 0, "1", "some-other-model");
    expect(() => admitDeclaredCells(declaration(), { cells }))
      .toThrow(/wrong model beta\/A-native-skill\/r0/u);
  });

  it("ignores cells outside the declaration without admitting them", () => {
    const cells = completeCells();
    cells["gamma/A-native-skill/r0"] = cell("gamma", "A-native-skill", 0, "1");
    const admitted = admitDeclaredCells(declaration(), { cells });
    expect(admitted.cells.some((c) => c.taskId === "gamma")).toBe(false);
    expect(admitted.undeclaredCellCount).toBe(1);
  });

  it("refuses an empty slate", () => {
    expect(() => admitDeclaredCells(declaration({ slate: [] }), { cells: completeCells() }))
      .toThrow(/empty slate/u);
  });

  describe("screening section", () => {
    it("admits screening cells tagged by section and fails closed on them too", () => {
      const cells = completeCells();
      cells["floor/A-native-skill/r0"] = cell("floor", "A-native-skill", 0, "0");
      cells["floor/C-no-instructions/r0"] = cell("floor", "C-no-instructions", 0, "0");
      const withScreening = declaration({
        screening: [{ taskId: "floor", expected: { "A-native-skill": 1, "C-no-instructions": 1 } }],
      });
      const admitted = admitDeclaredCells(withScreening, { cells });
      expect(admitted.cells.filter((c) => c.section === "screening")).toHaveLength(2);
      expect(admitted.cells.filter((c) => c.section === "slate")).toHaveLength(7);
      expect(admitted.undeclaredCellCount).toBe(0);

      delete cells["floor/C-no-instructions/r0"];
      expect(() => admitDeclaredCells(withScreening, { cells }))
        .toThrow(/missing cell floor\/C-no-instructions\/r0/u);
    });

    it("refuses a task declared in both sections", () => {
      const withOverlap = declaration({
        screening: [{ taskId: "alpha", expected: { "A-native-skill": 1 } }],
      });
      expect(() => admitDeclaredCells(withOverlap, { cells: completeCells() }))
        .toThrow(/alpha appears in both slate and screening/u);
    });
  });
});
