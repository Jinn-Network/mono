import type { SkillsBenchDemo1Declaration } from "./skillsbench-demo1-declaration.js";

/**
 * The current Demo-1 cell declarations.
 *
 * PILOT: the seven uplift-selected slate tasks that have completed cells in all three arms at
 * three replicates. This declaration exists to prove the evidence chain end to end on real cells;
 * it is retrospective (the cells predate it) and every artifact built from it says so.
 *
 * The FINAL declaration is authored after the arm-B screen closes the slate, sealed into the
 * analysis manifest, and committed before the deep run completes — that ordering is what makes
 * the deep run's cells prospectively declared.
 */
export const SKILLSBENCH_DEMO1_PILOT_DECLARATION: SkillsBenchDemo1Declaration = {
  schema: "jinn.demo1.cell-declaration.v1",
  model: "claude-haiku-4-5-20251001",
  slate: [
    { taskId: "dapt-intrusion-detection", expected: { "A-native-skill": 3, "B-flat-claude-md": 3, "C-no-instructions": 3 } },
    { taskId: "grid-dispatch-operator", expected: { "A-native-skill": 3, "B-flat-claude-md": 3, "C-no-instructions": 3 } },
    { taskId: "lake-warming-attribution", expected: { "A-native-skill": 3, "B-flat-claude-md": 3, "C-no-instructions": 3 } },
    { taskId: "llm-prefix-cache-replay", expected: { "A-native-skill": 3, "B-flat-claude-md": 3, "C-no-instructions": 3 } },
    { taskId: "mario-coin-counting", expected: { "A-native-skill": 3, "B-flat-claude-md": 3, "C-no-instructions": 3 } },
    { taskId: "radar-vital-signs", expected: { "A-native-skill": 3, "B-flat-claude-md": 3, "C-no-instructions": 3 } },
    { taskId: "threejs-structure-parser", expected: { "A-native-skill": 3, "B-flat-claude-md": 3, "C-no-instructions": 3 } },
  ],
};
