import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEMO1_DOCUMENT_SKILL_PATHS,
  DEMO1_PRE_RUN_FREEZE_SCHEMA,
  buildDemo1PreRunFreeze,
  canonicalDemo1PreRunFreezeBytes,
  demo1PreRunFreezeDigest,
  parseDemo1UpstreamSkill,
  type Demo1CandidateInput,
  type Demo1TaskEligibilityInput,
} from "./demo1-prerun.js";

const encoder = new TextEncoder();
const sha = (character: string) => character.repeat(64);
const evidence = (name: string) => ({
  uri: `urn:demo1:evidence:${name}`,
  sha256: createHash("sha256").update(name).digest("hex"),
});

function skill(name: string, description = `Use ${name} for repository work.`): Uint8Array {
  return encoder.encode(`---\nname: ${name}\ndescription: ${description}\nlicense: Complete terms in LICENSE.txt\n---\n\n# ${name}\n\nFollow this procedure.\n`);
}

function task(
  id: string,
  repository: string,
  pool: "suitability" | "rehearsal" | "official",
  overrides: Partial<Demo1TaskEligibilityInput["checks"]> = {},
): Demo1TaskEligibilityInput {
  const check = (name: string) => ({ status: "match" as const, evidence: [evidence(name)] });
  return {
    taskId: id,
    repository,
    pool,
    taskSha256: sha("a"),
    image: { digest: `sha256:${sha("b")}`, evidence: [evidence(`${id}-image`)] },
    checks: {
      goldPatchPasses: check(`${id}-gold`),
      emptyPatchFails: check(`${id}-empty`),
      compatibleTaskLicense: check(`${id}-license`),
      instructionLeakageAbsent: check(`${id}-leakage`),
      conflictingInstructionFileAbsent: check(`${id}-conflict`),
      contentGoldPatchCollisionAbsent: check(`${id}-collision`),
      ...overrides,
    },
  };
}

function candidate(
  path: string,
  tasks: readonly Demo1TaskEligibilityInput[],
  overrides: Partial<Demo1CandidateInput> = {},
): Demo1CandidateInput {
  const name = path.slice("skills/".length);
  return {
    repositoryPath: path,
    skillMd: skill(name),
    license: { spdxId: "Apache-2.0", bytes: encoder.encode("Apache License 2.0\n") },
    standalone: {
      status: "match",
      detail: "SKILL.md contains a usable procedure without sibling files.",
      evidence: [evidence(`${name}-standalone`)],
    },
    tasks,
    ...overrides,
  };
}

function readyInput(candidates: readonly Demo1CandidateInput[]) {
  return {
    source: {
      repositoryUrl: "https://github.com/anthropics/skills.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
      skillsTree: "89abcdef0123456789abcdef0123456789abcdef",
    },
    officialPoolRequirement: { status: "resolved" as const, tasks: 2, repositories: 1 },
    poolRequirements: {
      suitability: { tasks: 2, repositories: 2 },
      rehearsal: { tasks: 3, repositories: 2 },
    },
    candidates,
  };
}

const enoughTasks = (prefix: string) => [
  task(`${prefix}-s1`, `${prefix}/suitability-one`, "suitability"),
  task(`${prefix}-s2`, `${prefix}/suitability-two`, "suitability"),
  task(`${prefix}-r1`, `${prefix}/rehearsal-one`, "rehearsal"),
  task(`${prefix}-r2`, `${prefix}/rehearsal-two`, "rehearsal"),
  task(`${prefix}-r3`, `${prefix}/rehearsal-one`, "rehearsal"),
  task(`${prefix}-o1`, `${prefix}/official-one`, "official"),
  task(`${prefix}-o2`, `${prefix}/official-one`, "official"),
];

describe("Demo-1 pre-run source transform", () => {
  it("extracts the literal body and exact upstream description", () => {
    const bytes = encoder.encode("---\nname: claude-api\ndescription: |-\n  First line.\n  Second line.\nlicense: x\n---\n\n# Body\n");
    const parsed = parseDemo1UpstreamSkill(bytes);
    expect(parsed.name).toBe("claude-api");
    expect(parsed.description).toBe("First line.\nSecond line.");
    expect(new TextDecoder().decode(parsed.sourceMd)).toBe("# Body\n");
  });

  it.each([
    "no frontmatter",
    "---\nname: x\n---\n\nbody",
    "---\nname: x\ndescription: x\n---\r\n\r\nbody",
  ])("fails closed on malformed source bytes: %j", (text) => {
    expect(() => parseDemo1UpstreamSkill(encoder.encode(text))).toThrow();
  });
});

describe("Demo-1 pre-run freeze", () => {
  it("ranks ready candidates by eligible-task count then repository path and freezes literal loadout bytes", () => {
    const alpha = candidate("skills/alpha", enoughTasks("alpha"));
    const beta = candidate("skills/beta", [
      ...enoughTasks("beta"),
      task("beta-o3", "beta/official-one", "official"),
    ]);
    const freeze = buildDemo1PreRunFreeze(readyInput([beta, alpha]));

    expect(freeze.schema).toBe(DEMO1_PRE_RUN_FREEZE_SCHEMA);
    expect(freeze.status).toBe("ready");
    expect(freeze.ranking.map((entry) => entry.repositoryPath)).toEqual([
      "skills/beta",
      "skills/alpha",
    ]);
    expect(freeze.winner?.repositoryPath).toBe("skills/beta");
    expect(Buffer.from(freeze.winner!.sourceMd.content, "base64").toString("utf8"))
      .toBe("# beta\n\nFollow this procedure.\n");
    expect(Buffer.from(freeze.winner!.claudeMd.content, "base64"))
      .toEqual(Buffer.from(freeze.winner!.sourceMd.content, "base64"));
    expect(freeze.winner!.selectedPools.suitability).toHaveLength(2);
    expect(new Set(freeze.winner!.selectedPools.suitability.map((entry) => entry.repository)).size).toBe(2);
    expect(freeze.winner!.selectedPools.rehearsal).toHaveLength(3);
    expect(new Set(freeze.winner!.selectedPools.rehearsal.map((entry) => entry.repository)).size).toBeGreaterThanOrEqual(2);
  });

  it("uses lexicographic repository path as the exact tie-breaker", () => {
    const freeze = buildDemo1PreRunFreeze(readyInput([
      candidate("skills/zeta", enoughTasks("zeta")),
      candidate("skills/alpha", enoughTasks("alpha")),
    ]));
    expect(freeze.ranking.map((entry) => entry.repositoryPath)).toEqual(["skills/alpha", "skills/zeta"]);
  });

  it("excludes all four fixed document skills independently of their license", () => {
    expect(DEMO1_DOCUMENT_SKILL_PATHS).toEqual([
      "skills/docx",
      "skills/pdf",
      "skills/pptx",
      "skills/xlsx",
    ]);
    const freeze = buildDemo1PreRunFreeze(readyInput(
      DEMO1_DOCUMENT_SKILL_PATHS.map((path) => candidate(path, enoughTasks(path))),
    ));
    expect(freeze.status).toBe("stop");
    expect(freeze.candidates.every((entry) => entry.rejectionReasons.includes("source-available-document-skill")))
      .toBe(true);
  });

  it("refuses missing licenses, descriptions, non-standalone instructions, and unresolved official capacity", () => {
    const freeze = buildDemo1PreRunFreeze({
      ...readyInput([
        candidate("skills/missing-license", enoughTasks("license"), { license: undefined }),
        candidate("skills/not-standalone", enoughTasks("standalone"), {
          standalone: { status: "mismatch", detail: "Requires sibling scripts.", evidence: [evidence("standalone-fail")] },
        }),
      ]),
      officialPoolRequirement: {
        status: "unresolved",
        detail: "E2 has not frozen the official task capacity requirement.",
      } as const,
    });
    expect(freeze.status).toBe("stop");
    expect(freeze.stopReasons).toContain("official-pool-requirement-unresolved");
    expect(freeze.candidates.find((entry) => entry.repositoryPath === "skills/missing-license")?.rejectionReasons)
      .toContain("missing-compatible-folder-license");
    expect(freeze.candidates.find((entry) => entry.repositoryPath === "skills/not-standalone")?.rejectionReasons)
      .toContain("instructions-not-standalone");
  });

  it.each([
    "goldPatchPasses",
    "emptyPatchFails",
    "compatibleTaskLicense",
    "instructionLeakageAbsent",
    "conflictingInstructionFileAbsent",
    "contentGoldPatchCollisionAbsent",
  ] as const)("does not count a task when %s lacks matching evidence", (criterion) => {
    const bad = task("bad", "repo/bad", "official", {
      [criterion]: { status: "unverifiable", detail: "proof absent", evidence: [] },
    });
    const freeze = buildDemo1PreRunFreeze(readyInput([
      candidate("skills/alpha", [...enoughTasks("alpha"), bad]),
    ]));
    const inventory = freeze.candidates[0]!.tasks.find((entry) => entry.taskId === "bad")!;
    expect(inventory.eligible).toBe(false);
    expect(inventory.rejectionReasons).toContain(criterion);
  });

  it("stops on cross-pool repository overlap even when every task is otherwise eligible", () => {
    const tasks = enoughTasks("alpha");
    tasks[5] = task("alpha-o1", "alpha/suitability-one", "official");
    const freeze = buildDemo1PreRunFreeze(readyInput([candidate("skills/alpha", tasks)]));
    expect(freeze.status).toBe("stop");
    expect(freeze.candidates[0]!.rejectionReasons).toContain("repository-pool-overlap");
  });

  it("records the exact insufficient pool instead of leaving a partial candidate unexplained", () => {
    const partial = enoughTasks("alpha").slice(0, -1);
    const freeze = buildDemo1PreRunFreeze(readyInput([candidate("skills/alpha", partial)]));
    expect(freeze.status).toBe("stop");
    expect(freeze.candidates[0]!.eligibleTaskCount).toBeGreaterThan(0);
    expect(freeze.candidates[0]!.rejectionReasons).toContain("insufficient-official-pool");
  });

  it("refuses a pool requirement with more repositories than tasks", () => {
    const input = readyInput([candidate("skills/alpha", enoughTasks("alpha"))]);
    expect(() => buildDemo1PreRunFreeze({
      ...input,
      poolRequirements: { ...input.poolRequirements, suitability: { tasks: 2, repositories: 3 } },
    })).toThrow(/repository count cannot exceed task count/u);
  });

  it("derives resolved SHA-256 integer seeds and canonical bytes solely from frozen inputs", () => {
    const input = readyInput([candidate("skills/alpha", enoughTasks("alpha"))]);
    const first = buildDemo1PreRunFreeze(input);
    const second = buildDemo1PreRunFreeze(input);
    expect(first.seeds).toEqual(second.seeds);
    for (const value of Object.values(first.seeds.resolved)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(4_294_967_295);
    }
    expect(canonicalDemo1PreRunFreezeBytes(first)).toEqual(canonicalDemo1PreRunFreezeBytes(second));
    expect(demo1PreRunFreezeDigest(first)).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const changed = buildDemo1PreRunFreeze({
      ...input,
      source: { ...input.source, commit: "1123456789abcdef0123456789abcdef01234567" },
    });
    expect(changed.seeds.resolved).not.toEqual(first.seeds.resolved);
  });

  it("keeps the pinned 17-folder upstream inventory canonical and explicitly stopped", () => {
    const fixtureUrl = new URL(
      "../../../../../docs/superpowers/plans/demo-report-1/E1-pre-run-freeze.stop.v1.json",
      import.meta.url,
    );
    const fileBytes = readFileSync(fixtureUrl);
    const parsed = JSON.parse(fileBytes.toString("utf8")) as {
      readonly schema: string;
      readonly status: string;
      readonly source: { readonly repositoryUrl: string; readonly commit: string; readonly skillsTree: string };
      readonly documentSkillExclusions: readonly string[];
      readonly candidates: readonly { readonly repositoryPath: string; readonly eligibleTaskCount: number; readonly descriptionPresent: boolean }[];
      readonly ranking: readonly unknown[];
      readonly winner: unknown;
      readonly stopReasons: readonly string[];
      readonly execution: Readonly<Record<string, number>>;
    };
    expect(parsed.schema).toBe("jinn.demo1.pre-run-source-inventory.v1");
    expect(parsed.source).toEqual({
      repositoryUrl: "https://github.com/anthropics/skills.git",
      commit: "f17010c9bb483898c1d9c9f42dde2b3a98889434",
      skillsTree: "491339fffffe73a52f638f09747dddd8ae2cf154",
    });
    expect(parsed.candidates).toHaveLength(17);
    expect(parsed.candidates.map((entry) => entry.repositoryPath)).toEqual([
      "skills/algorithmic-art",
      "skills/brand-guidelines",
      "skills/canvas-design",
      "skills/claude-api",
      "skills/doc-coauthoring",
      "skills/docx",
      "skills/frontend-design",
      "skills/internal-comms",
      "skills/mcp-builder",
      "skills/pdf",
      "skills/pptx",
      "skills/skill-creator",
      "skills/slack-gif-creator",
      "skills/theme-factory",
      "skills/web-artifacts-builder",
      "skills/webapp-testing",
      "skills/xlsx",
    ]);
    expect(parsed.status).toBe("stop");
    expect(parsed.winner).toBeNull();
    expect(parsed.ranking).toEqual([]);
    expect(parsed.candidates.every((entry) => entry.eligibleTaskCount === 0)).toBe(true);
    expect(parsed.candidates.every((entry) => entry.descriptionPresent)).toBe(true);
    expect(parsed.documentSkillExclusions).toEqual(DEMO1_DOCUMENT_SKILL_PATHS);
    expect(parsed.stopReasons).toEqual([
      "official-pool-requirement-unresolved",
      "no-candidate-supports-disjoint-suitability-rehearsal-official-pools",
    ]);
    expect(Object.values(parsed.execution).every((count) => count === 0)).toBe(true);
    const canonicalDigest = createHash("sha256")
      .update(canonicalDemo1PreRunFreezeBytes(parsed as never))
      .digest("hex");
    expect(`sha256:${canonicalDigest}`)
      .toBe("sha256:ac213523dc8292edb18066c05826454bb44a79f6a6dc9dd1cfa7e984aac35f66");
  });
});
