import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEMO1_DOCUMENT_SKILL_PATHS,
  DEMO1_PINNED_SKILLS_SOURCE,
  DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR,
  DEMO1_PRE_RUN_FREEZE_SCHEMA,
  DEMO1_REHEARSAL_POOL_REQUIREMENT,
  DEMO1_SUITABILITY_POOL_REQUIREMENT,
  buildDemo1PreRunFreeze,
  canonicalDemo1PreRunFreezeBytes,
  demo1PreRunFreezeDigest,
  parseDemo1UpstreamSkill,
  verifyDemo1PreRunFreeze,
  type Demo1PreRunFreeze,
  type Demo1PreRunFreezeInput,
  type Demo1TaskEligibilityInput,
} from "../index.js";

const encoder = new TextEncoder();
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const evidence = (name: string) => ({ uri: `urn:demo1:evidence:${name}`, sha256: digest(name) });

const artifactUrl = new URL(
  "../../../../../docs/superpowers/plans/demo-report-1/E1-pre-run-freeze.stop.v2.json",
  import.meta.url,
);
const winnerSkillUrl = new URL("./__fixtures__/anthropics-skills-f17010-brand-guidelines.SKILL.md", import.meta.url);

function readStoppedFreeze(): Demo1PreRunFreeze {
  return JSON.parse(readFileSync(artifactUrl, "utf8")) as Demo1PreRunFreeze;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function task(id: string, repository: string, pool: "suitability" | "rehearsal" | "official"): Demo1TaskEligibilityInput {
  const check = (criterion: string) => ({ status: "match" as const, evidence: [evidence(`${id}:${criterion}`)] });
  return {
    taskId: id,
    repository,
    pool,
    taskSha256: digest(`task:${id}`),
    image: { digest: `sha256:${digest(`image:${id}`)}`, evidence: [evidence(`${id}:image`)] },
    checks: {
      goldPatchPasses: check("gold"),
      emptyPatchFails: check("empty"),
      compatibleTaskLicense: check("license"),
      instructionLeakageAbsent: check("leakage"),
      conflictingInstructionFileAbsent: check("conflict"),
      contentGoldPatchCollisionAbsent: check("collision"),
    },
  };
}

function readyInput(): Demo1PreRunFreezeInput {
  const input = clone(readStoppedFreeze().inputs) as Demo1PreRunFreezeInput;
  const mutable = input as unknown as {
    candidates: Array<{
      repositoryPath: string;
      skillMdBase64?: string;
      tasks: Demo1TaskEligibilityInput[];
    }>;
  };
  const candidate = mutable.candidates.find((entry) => entry.repositoryPath === "skills/brand-guidelines")!;
  candidate.skillMdBase64 = readFileSync(winnerSkillUrl).toString("base64");
  candidate.tasks = [
    ...Array.from({ length: 6 }, (_, index) => task(`s-${index}`, `suitability/repo-${index}`, "suitability")),
    ...Array.from({ length: 10 }, (_, index) => task(`r-${index}`, `rehearsal/repo-${index % 5}`, "rehearsal")),
    ...Array.from({ length: 7 }, (_, index) => task(`o-${index}`, `official/repo-${index % 3}`, "official")),
  ];
  return input;
}

describe("Demo-1 pre-run source transform", () => {
  it("extracts the literal instruction body and exact multiline description", () => {
    const bytes = encoder.encode("---\nname: claude-api\ndescription: |-\n  First line.\n  Second line.\nlicense: x\n---\n\n# Body\n");
    const parsed = parseDemo1UpstreamSkill(bytes);
    expect(parsed).toEqual({
      name: "claude-api",
      description: "First line.\nSecond line.",
      sourceMd: encoder.encode("# Body\n"),
    });
  });

  it.each([
    "no frontmatter",
    "---\nname: x\n---\n\nbody",
    "---\nname: x\ndescription: x\n---\r\n\r\nbody",
  ])("fails closed on malformed source bytes: %j", (text) => {
    expect(() => parseDemo1UpstreamSkill(encoder.encode(text))).toThrow();
  });
});

describe("Demo-1 canonical STOP artifact", () => {
  it("independently recomputes every status, rejection, rank, selection basis, and seed", () => {
    const frozen = readStoppedFreeze();
    verifyDemo1PreRunFreeze(frozen);
    const recomputed = buildDemo1PreRunFreeze(frozen.inputs);

    expect(recomputed).toEqual(frozen);
    expect(frozen.schema).toBe(DEMO1_PRE_RUN_FREEZE_SCHEMA);
    expect(frozen.derived.status).toBe("stop");
    expect(frozen.derived.winner).toBeNull();
    expect(frozen.derived.ranking).toEqual([]);
    expect(frozen.derived.stopReasons).toEqual(["no-candidate-meets-pre-e2-feasibility-floor"]);
    expect(frozen.derived.candidates).toHaveLength(17);
    expect(frozen.derived.candidates.every((entry) => entry.eligibleTaskCount === 0)).toBe(true);
    expect(frozen.inputs.candidates.every((entry) => entry.source.skill.description.length > 0)).toBe(true);
    expect(frozen.inputs.candidates.every((entry) => entry.source.skill.bytes > 0)).toBe(true);
    expect(frozen.inputs.candidates.every((entry) => entry.standalone.evidence.length > 0)).toBe(true);
    expect(Object.values(frozen.execution).every((count) => count === 0)).toBe(true);
  });

  it("preserves the exact pinned tree, complete 17-folder inventory, and four exclusions", () => {
    const frozen = readStoppedFreeze();
    expect(frozen.inputs.source).toEqual({
      authentication: "git-tree-path-blob+sha256@1",
      repositoryUrl: "https://github.com/anthropics/skills.git",
      commit: "f17010c9bb483898c1d9c9f42dde2b3a98889434",
      commitTree: "0fe4c0c8372b239b13062036d08d05f79d4055a1",
      skillsTree: "491339fffffe73a52f638f09747dddd8ae2cf154",
    });
    expect(frozen.inputs.candidates.map((entry) => entry.repositoryPath))
      .toEqual(DEMO1_PINNED_SKILLS_SOURCE.candidates.map((entry) => entry.repositoryPath));
    expect(frozen.inputs.exclusions.documentSkills).toEqual(DEMO1_DOCUMENT_SKILL_PATHS);
    expect(frozen.inputs.poolRequirements.officialFeasibilityFloor)
      .toEqual(DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR);
    expect(frozen.inputs.poolRequirements.suitability)
      .toEqual(DEMO1_SUITABILITY_POOL_REQUIREMENT);
    expect(frozen.inputs.poolRequirements.rehearsal)
      .toEqual(DEMO1_REHEARSAL_POOL_REQUIREMENT);
  });

  it("uses canonical bytes and refuses derived-field or execution-accounting substitution", () => {
    const frozen = readStoppedFreeze();
    expect(demo1PreRunFreezeDigest(frozen)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(canonicalDemo1PreRunFreezeBytes(frozen)).toEqual(canonicalDemo1PreRunFreezeBytes(readStoppedFreeze()));

    const changedDerived = clone(frozen) as unknown as { derived: { selectionBasisSha256: string } };
    changedDerived.derived.selectionBasisSha256 = "0".repeat(64);
    expect(() => verifyDemo1PreRunFreeze(changedDerived as unknown as Demo1PreRunFreeze)).toThrow(/do not recompute/u);

    const changedExecution = clone(frozen) as unknown as { execution: { modelArms: number } };
    changedExecution.execution.modelArms = 1;
    expect(() => verifyDemo1PreRunFreeze(changedExecution as unknown as Demo1PreRunFreeze)).toThrow(/zero-execution/u);
  });

  it("refuses a semantically equivalent artifact whose input arrays are not canonical", () => {
    const changed = clone(readStoppedFreeze()) as unknown as { inputs: { candidates: unknown[] } };
    changed.inputs.candidates.reverse();
    expect(() => verifyDemo1PreRunFreeze(changed as unknown as Demo1PreRunFreeze)).toThrow(/canonical normalized form/u);
  });
});

describe("Demo-1 authenticated source and license boundary", () => {
  it.each(["commit", "commitTree", "skillsTree"] as const)("rejects substituted source %s", (field) => {
    const input = clone(readStoppedFreeze().inputs) as unknown as Record<string, unknown>;
    const source = input.source as Record<string, unknown>;
    source[field] = field === "commit" ? "0".repeat(40) : "1".repeat(40);
    expect(() => buildDemo1PreRunFreeze(input as unknown as Demo1PreRunFreezeInput)).toThrow(/pinned Git tree/u);
  });

  it("rejects arbitrary SKILL, description, folder-tree, and license identity labels", () => {
    const mutations: Array<(candidate: Record<string, unknown>) => void> = [
      (candidate) => { (candidate.source as { folderTree: string }).folderTree = "0".repeat(40); },
      (candidate) => { ((candidate.source as { skill: { sha256: string } }).skill).sha256 = "0".repeat(64); },
      (candidate) => { ((candidate.source as { skill: { description: string } }).skill).description = "substituted"; },
      (candidate) => { ((candidate.source as { license: { spdxId: string } }).license).spdxId = "MIT"; },
    ];
    for (const mutate of mutations) {
      const input = clone(readStoppedFreeze().inputs) as unknown as { candidates: Record<string, unknown>[] };
      mutate(input.candidates[1]!);
      expect(() => buildDemo1PreRunFreeze(input as unknown as Demo1PreRunFreezeInput)).toThrow(/identity|pinned Git tree|authenticated bytes/u);
    }
  });

  it("requires every exact pinned folder exactly once and rejects unknown schema fields", () => {
    const missing = clone(readStoppedFreeze().inputs) as unknown as { candidates: unknown[] };
    missing.candidates.pop();
    expect(() => buildDemo1PreRunFreeze(missing as unknown as Demo1PreRunFreezeInput)).toThrow(/every pinned source folder/u);

    const extra = clone(readStoppedFreeze().inputs) as unknown as Record<string, unknown>;
    extra.callerDeclaredTrust = true;
    expect(() => buildDemo1PreRunFreeze(extra as unknown as Demo1PreRunFreezeInput)).toThrow(/unknown or missing fields/u);
  });
});

describe("Demo-1 pre-E2 selection boundary", () => {
  it.each([
    ["suitability", "6-task/6-repository"],
    ["rehearsal", "10-task/5-repository"],
  ] as const)("refuses a caller-weakened %s pool requirement", (pool, expected) => {
    const input = readyInput() as unknown as {
      poolRequirements: Record<typeof pool, { tasks: number; repositories: number }>;
    };
    input.poolRequirements[pool] = { tasks: 1, repositories: 1 };
    expect(() => buildDemo1PreRunFreeze(input as unknown as Demo1PreRunFreezeInput)).toThrow(expected);
  });

  it("locks a qualifying winner before E2 while exact official capacity remains pending", () => {
    const frozen = buildDemo1PreRunFreeze(readyInput());
    expect(frozen.derived.status).toBe("ready");
    expect(frozen.derived.winner?.repositoryPath).toBe("skills/brand-guidelines");
    expect(frozen.inputs.officialDesign.exactCapacity).toBeNull();
    expect(frozen.inputs.officialDesign.winnerLockedBeforeE2).toBe(true);
    expect(frozen.derived.winner?.selectedPools.suitability).toHaveLength(6);
    expect(frozen.derived.winner?.selectedPools.rehearsal).toHaveLength(10);
    expect(frozen.derived.winner?.selectedPools.officialFeasibility).toHaveLength(5);
    expect(frozen.derived.winner?.officialTaskOrder).toHaveLength(7);
    expect(Buffer.from(frozen.derived.winner!.sourceMd.content, "base64"))
      .toEqual(Buffer.from(frozen.derived.winner!.claudeMd.content, "base64"));
  });

  it("stops below the objective official feasibility floor without waiting for E2", () => {
    const input = readyInput();
    const mutable = input as unknown as { candidates: Array<{ repositoryPath: string; tasks: Demo1TaskEligibilityInput[] }> };
    const candidate = mutable.candidates.find((entry) => entry.repositoryPath === "skills/brand-guidelines")!;
    candidate.tasks = candidate.tasks.filter((entry) => entry.pool !== "official").concat([
      task("o-0", "official/repo-0", "official"),
      task("o-1", "official/repo-1", "official"),
      task("o-2", "official/repo-0", "official"),
      task("o-3", "official/repo-1", "official"),
    ]);
    const frozen = buildDemo1PreRunFreeze(input);
    expect(frozen.derived.status).toBe("stop");
    expect(frozen.derived.candidates.find((entry) => entry.repositoryPath === "skills/brand-guidelines")?.rejectionReasons)
      .toContain("insufficient-official-feasibility-pool");
  });

  it("does not accept a caller-resolved E2 capacity or permit outcome-informed switching", () => {
    const input = readyInput() as unknown as { officialDesign: Record<string, unknown> };
    input.officialDesign.status = "resolved";
    input.officialDesign.exactCapacity = { tasks: 20, repositories: 10 };
    expect(() => buildDemo1PreRunFreeze(input as unknown as Demo1PreRunFreezeInput)).toThrow(/pending E2/u);
  });

  it("never treats matching task or standalone claims without evidence as eligible", () => {
    const input = readyInput();
    const mutable = input as unknown as { candidates: Array<{ repositoryPath: string; tasks: Demo1TaskEligibilityInput[] }> };
    const candidate = mutable.candidates.find((entry) => entry.repositoryPath === "skills/brand-guidelines")!;
    candidate.tasks.push({
      ...task("unproved", "official/unproved", "official"),
      checks: {
        ...task("unproved", "official/unproved", "official").checks,
        goldPatchPasses: { status: "match", evidence: [] },
      },
    });
    expect(() => buildDemo1PreRunFreeze(input)).toThrow(/cannot match without evidence/u);
  });

  it("fails closed if winner source bytes do not match the pinned path/blob", () => {
    const input = readyInput() as unknown as { candidates: Array<{ repositoryPath: string; skillMdBase64?: string }> };
    const candidate = input.candidates.find((entry) => entry.repositoryPath === "skills/brand-guidelines")!;
    candidate.skillMdBase64 = Buffer.from("substituted").toString("base64");
    expect(() => buildDemo1PreRunFreeze(input as unknown as Demo1PreRunFreezeInput)).toThrow(/do not match the pinned path\/blob/u);
  });

  it("normalizes task and evidence ordering before deriving selectionBasisSha256 and seeds", () => {
    const firstInput = readyInput();
    const secondInput = clone(firstInput) as unknown as { candidates: Array<{ repositoryPath: string; tasks: Demo1TaskEligibilityInput[] }> };
    const candidate = secondInput.candidates.find((entry) => entry.repositoryPath === "skills/brand-guidelines")!;
    candidate.tasks.reverse();
    const first = buildDemo1PreRunFreeze(firstInput);
    const second = buildDemo1PreRunFreeze(secondInput as unknown as Demo1PreRunFreezeInput);
    expect(second.inputs).toEqual(first.inputs);
    expect(second.derived.selectionBasisSha256).toBe(first.derived.selectionBasisSha256);
    expect(second.derived.seeds).toEqual(first.derived.seeds);
  });
});
