import { readSkillsBenchReward } from "./skillsbench-reward.js";

/**
 * The declared cell inventory for a Demo-1 report build.
 *
 * The declaration is authored before the cells it names are complete and the report builder
 * admits cells against it fail-closed: a declared cell that is missing, unparseable, or ran on the
 * wrong model is a build failure, never a smaller denominator. Nothing here reads an outcome —
 * the declaration names cells, not results.
 */
export const SKILLSBENCH_DEMO1_DECLARATION_SCHEMA = "jinn.demo1.cell-declaration.v1" as const;

export type SkillsBenchDemo1Arm = "A-native-skill" | "B-flat-claude-md" | "C-no-instructions";

export interface SkillsBenchDemo1SlateEntry {
  readonly taskId: string;
  /** Expected replicate count per arm. An absent arm expects zero cells. */
  readonly expected: Partial<Record<SkillsBenchDemo1Arm, number>>;
}

export interface SkillsBenchDemo1Declaration {
  readonly schema: typeof SKILLSBENCH_DEMO1_DECLARATION_SCHEMA;
  /** The subject model every admitted cell must have run on. */
  readonly model: string;
  /** The analysis population: tasks whose cells enter the paired estimate. */
  readonly slate: readonly SkillsBenchDemo1SlateEntry[];
  /**
   * Slate-selection evidence: every other cell the experiment produced, enumerated exactly.
   * Screening cells are admitted into the evidence cohort under the same fail-closed rules but
   * are excluded from the paired analysis by declaration, not by outcome.
   */
  readonly screening?: readonly SkillsBenchDemo1SlateEntry[];
}

export interface SkillsBenchDemo1CellRecord {
  readonly taskId: string;
  readonly arm: string;
  readonly replicate: number;
  readonly model: string;
  readonly reward: string | null;
  readonly baseImage?: string;
}

export interface SkillsBenchDemo1AdmittedCell {
  readonly cellId: string;
  readonly section: "slate" | "screening";
  readonly taskId: string;
  readonly arm: SkillsBenchDemo1Arm;
  readonly replicate: number;
  readonly reward: string;
  readonly rewardValue: number;
  readonly fullPass: boolean;
  readonly baseImage: string | undefined;
}

export interface SkillsBenchDemo1Admission {
  readonly cells: readonly SkillsBenchDemo1AdmittedCell[];
  /** Cells present in the document but not named by the declaration. Counted, never admitted. */
  readonly undeclaredCellCount: number;
}

/** Carries every problem at once so a failed build names the full missing set. */
export class SkillsBenchDeclarationError extends Error {
  public readonly problems: readonly string[];

  public constructor(problems: readonly string[]) {
    super(`declaration not satisfied:\n  ${problems.join("\n  ")}`);
    this.name = "SkillsBenchDeclarationError";
    this.problems = problems;
  }
}

/**
 * Admits exactly the declared cells from a sealed cells document.
 *
 * Throws with the complete problem list when any declared cell is missing, has an unparseable or
 * absent reward, or ran on a model other than the declared one.
 */
export function admitDeclaredCells(
  declaration: SkillsBenchDemo1Declaration,
  document: { readonly cells: Record<string, SkillsBenchDemo1CellRecord> },
): SkillsBenchDemo1Admission {
  if (declaration.slate.length === 0) throw new SkillsBenchDeclarationError(["empty slate"]);
  const slateTasks = new Set(declaration.slate.map((entry) => entry.taskId));
  for (const entry of declaration.screening ?? []) {
    if (slateTasks.has(entry.taskId)) {
      throw new SkillsBenchDeclarationError([`${entry.taskId} appears in both slate and screening`]);
    }
  }

  const problems: string[] = [];
  const admitted: SkillsBenchDemo1AdmittedCell[] = [];
  const declared = new Set<string>();

  const sections: readonly ["slate" | "screening", readonly SkillsBenchDemo1SlateEntry[]][] = [
    ["slate", declaration.slate],
    ["screening", declaration.screening ?? []],
  ];
  for (const [section, entries] of sections) {
    for (const entry of entries) {
      for (const [arm, count] of Object.entries(entry.expected) as [SkillsBenchDemo1Arm, number][]) {
        for (let replicate = 0; replicate < count; replicate += 1) {
          const cellId = `${entry.taskId}/${arm}/r${replicate}`;
          declared.add(cellId);
          const record = document.cells[cellId];
          if (record === undefined) {
            problems.push(`missing cell ${cellId}`);
            continue;
          }
          if (record.model !== declaration.model) {
            problems.push(`wrong model ${cellId}: ${record.model}`);
            continue;
          }
          const reading = readSkillsBenchReward({ rewardTxt: record.reward });
          if (reading.outcome === "unscorable" || reading.rawReward === null) {
            problems.push(`unparseable reward ${cellId}: ${String(record.reward)}`);
            continue;
          }
          admitted.push({
            cellId,
            section,
            taskId: entry.taskId,
            arm,
            replicate,
            reward: record.reward as string,
            rewardValue: reading.rawReward,
            fullPass: reading.outcome === "full-pass",
            baseImage: record.baseImage,
          });
        }
      }
    }
  }

  if (problems.length > 0) throw new SkillsBenchDeclarationError(problems);

  const undeclaredCellCount = Object.keys(document.cells).filter((id) => !declared.has(id)).length;
  admitted.sort((left, right) => (left.cellId < right.cellId ? -1 : left.cellId > right.cellId ? 1 : 0));
  return { cells: admitted, undeclaredCellCount };
}
