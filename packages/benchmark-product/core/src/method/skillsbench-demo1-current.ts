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

/**
 * FINAL: the confirmatory flat-design declaration. Population = every statically-admitted task
 * (all 41 build on the amd64 run hosts — the probe left no exclusions), uniform A×5 / B×5 / C×2.
 * No task was selected or dropped on any outcome. Sealed and committed before any confirmatory
 * cell existed; the informative-subset conditioning is declared in the manifest, not applied here.
 */
export const SKILLSBENCH_DEMO1_FINAL_DECLARATION: SkillsBenchDemo1Declaration = {
  schema: "jinn.demo1.cell-declaration.v1",
  model: "claude-haiku-4-5-20251001",
  slate: [
    { taskId: "3d-scan-calc", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "ada-bathroom-plan-repair", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "adaptive-cruise-control", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "azure-bgp-oscillation-route-leak", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "bike-rebalance", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "dapt-intrusion-detection", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "data-to-d3", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "drone-planning-control", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "edit-pdf", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "energy-ac-optimal-power-flow", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "energy-market-pricing", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "energy-unit-commitment", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "enterprise-information-search", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "exam-block-sequencing", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "glm-lake-mendota", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "grid-dispatch-operator", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "hvac-control", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "jax-computing-basics", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "lake-warming-attribution", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "llm-prefix-cache-replay", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "manufacturing-codebook-normalization", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "manufacturing-equipment-maintenance", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "manufacturing-fjsp-optimization", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "mario-coin-counting", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "mars-clouds-clustering", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "multilingual-video-dubbing", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "parallel-tfidf-search", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "paratransit-routing", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "pddl-airport-planning", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "pddl-tpp-planning", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "r2r-mpc-control", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "radar-vital-signs", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "react-performance-debugging", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "sec-financial-report", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "suricata-custom-exfil", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "syzkaller-ppdev-syzlang", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "threejs-structure-parser", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "threejs-to-obj", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "tictoc-unnecessary-abort-detection", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "travel-planning", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
    { taskId: "video-silence-remover", expected: { "A-native-skill": 5, "B-flat-claude-md": 5, "C-no-instructions": 2 } },
  ],
};
