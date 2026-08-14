import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import {
  DEMO1_CLAUDE_EFFORT,
  DEMO1_CLAUDE_MD_PATH,
  DEMO1_CLAUDE_MODEL_ID,
  DEMO1_SKILL_PATH,
  DEMO1_SKILL_PLUGIN_DIRECTORY,
  createDemo1ClaudeCandidateRuntimeBinding,
  createDemo1ClaudeRuntimeBinding,
  createDemo1ClaudeSelectedRuntimeBinding,
  demo1ClaudeArmRequirements,
  generateDemo1InstructionArtifacts,
  makeDemo1ClaudeLauncher,
} from "./demo1-claude.js";
import {
  buildDemo1RuntimeSelection,
  decideDemo1Runtime,
} from "../method/demo1-runtime-policy.js";

const source = new TextEncoder().encode("# Frozen instructions\n\nDo the exact task.\n");
const artifacts = generateDemo1InstructionArtifacts(source, {
  name: "demo1-procedure",
  description: "Use for repository implementation tasks.",
});
const HARNESS_VERSION = "2.1.222";

const paths: WorkspacePaths = {
  root: "/attempt",
  input: "/attempt/input",
  work: "/attempt/work",
  out: "/attempt/out",
  logs: "/attempt/logs",
  harnessState: "/attempt/harness-state",
  secrets: "/attempt/secrets",
  tmp: "/attempt/tmp",
  meta: "/attempt/meta",
};
const attempt: AttemptIdentity = {
  attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000001",
  nonce: "demo1",
  attemptNumber: 1,
};

function runtime(
  authenticated = true,
  harnessVersion = HARNESS_VERSION,
  versionOutput = `${HARNESS_VERSION} (Claude Code)\n`,
) {
  const calls: string[][] = [];
  const binding = createDemo1ClaudeRuntimeBinding({
    executablePath: process.execPath,
    harnessVersion,
    artifacts,
    command: async (_path, args) => {
      calls.push([...args]);
      return args[0] === "auth"
        ? { stdout: JSON.stringify({ loggedIn: authenticated }) }
        : { stdout: versionOutput };
    },
  });
  return { binding, calls };
}

function view(requirements: Readonly<Record<string, unknown>>): TaskView {
  return {
    task: {
      instructions: "Fix the repository.",
      outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    },
    effectiveRequirements: requirements,
    profile: { profile: "https://spec.jinn.network/task-profiles/repository-work/1.0" },
  } as TaskView;
}

describe("Demo-1 deterministic instruction artifacts", () => {
  it("keeps CLAUDE.md byte-identical and appends source.md verbatim after skill frontmatter", () => {
    expect(artifacts.claudeMd).toEqual(source);
    expect(artifacts.skillMd.slice(artifacts.skillFrontmatter.length)).toEqual(source);
    expect(new TextDecoder().decode(artifacts.skillFrontmatter)).toBe(
      '---\nname: "demo1-procedure"\ndescription: "Use for repository implementation tasks."\n---\n\n',
    );
    expect(Buffer.from(artifacts.skill.content, "base64")).toEqual(Buffer.from(artifacts.skillMd));
    expect(Buffer.from(artifacts.baseline.content, "base64")).toEqual(Buffer.from(source));
  });

  it("refuses multiline frontmatter fields so the transform stays literal", () => {
    expect(() => generateDemo1InstructionArtifacts(source, { name: "bad\nname", description: "x" }))
      .toThrow(/one non-empty line/u);
  });
});

describe("Demo-1 real Claude runtime inventory", () => {
  it("probes the exact model/effort flags, version, auth, and echoes exact inventories", async () => {
    const { binding, calls } = runtime();
    const readiness = await binding.probe();
    expect(readiness.ready).toBe(true);
    expect(calls).toEqual([
      ["--model", DEMO1_CLAUDE_MODEL_ID, "--effort", DEMO1_CLAUDE_EFFORT, "--version"],
      ["auth", "status"],
    ]);
    expect(readiness.models).toEqual([DEMO1_CLAUDE_MODEL_ID]);
    expect(readiness.harnessVersions).toEqual([HARNESS_VERSION]);
    expect(readiness.loadouts).toEqual([
      { kind: "jinn.skill.v1", name: "SKILL.md", digest: artifacts.skill.digest.sha256 },
      { kind: "jinn.skill.v1", name: "CLAUDE.md", digest: artifacts.baseline.digest.sha256 },
    ]);
  });

  it("fails readiness when real authentication is not available", async () => {
    expect((await runtime(false).binding.probe()).ready).toBe(false);
  });

  it.each(["", "2.1", "2.1.222.1"])(
    "refuses configured version %j rather than accepting an observed exact-version prefix",
    async (configured) => {
      const readiness = await runtime(true, configured).binding.probe();
      expect(readiness.ready).toBe(false);
      expect(readiness.harnessVersions).toEqual([HARNESS_VERSION]);
      expect(readiness.detail).toMatch(/version mismatch/u);
    },
  );

  it.each([
    "",
    "2.1.222",
    "2.1.222-beta (Claude Code)",
    "2.1.222 (Claude Code) extra",
    "Claude Code 2.1.222",
  ])("refuses malformed or non-exact Claude version output %j", async (output) => {
    const readiness = await runtime(true, HARNESS_VERSION, output).binding.probe();
    expect(readiness.ready).toBe(false);
    expect(readiness.harnessVersions).toEqual([]);
    expect(readiness.detail).toMatch(/malformed version output/u);
  });

  it("uses Haiku low for the first v2 suitability candidate without changing v1", async () => {
    const calls: string[][] = [];
    const binding = createDemo1ClaudeCandidateRuntimeBinding({
      executablePath: process.execPath,
      harnessVersion: HARNESS_VERSION,
      artifacts,
      candidateIndex: 0,
      command: async (_path, args) => {
        calls.push([...args]);
        return args[0] === "auth"
          ? { stdout: JSON.stringify({ loggedIn: true }) }
          : { stdout: `${HARNESS_VERSION} (Claude Code)\n` };
      },
    });
    expect(await binding.probe()).toMatchObject({ ready: true, models: ["claude-haiku-4-5-20251001"] });
    expect(binding.effort).toBe("low");
    expect(calls[0]).toEqual([
      "--model", "claude-haiku-4-5-20251001", "--effort", "low", "--version",
    ]);
    expect(runtime().binding.effort).toBe(DEMO1_CLAUDE_EFFORT);
  });

  it("binds a selected v2 runtime only to the executable measured by the selection", () => {
    const decision = decideDemo1Runtime(0, {
      expectedCells: 12,
      accountedCells: 12,
      validGraderOutcomes: 12,
      passes: 5,
      timeoutFails: 0,
      unresolvedInfrastructure: 0,
      incompatibilities: 0,
      skillLoaderCanary: "pass",
    });
    const executableSha256 = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
    const selection = buildDemo1RuntimeSelection({
      decision,
      harnessVersion: HARNESS_VERSION,
      executableSha256,
      skillSha256: artifacts.skill.digest.sha256,
      taskPoolSha256: "c".repeat(64),
    });
    const binding = createDemo1ClaudeSelectedRuntimeBinding({
      executablePath: process.execPath,
      harnessVersion: HARNESS_VERSION,
      artifacts,
      selection,
      decision,
      command: async () => ({ stdout: "" }),
    });
    expect(binding).toMatchObject({ modelId: "claude-haiku-4-5-20251001", effort: "low" });
    expect(() => createDemo1ClaudeSelectedRuntimeBinding({
      executablePath: process.execPath,
      harnessVersion: "2.1.223",
      artifacts,
      selection,
      decision,
    })).toThrow(/does not match/u);
  });
});

describe("Demo-1 Claude arm plans", () => {
  it("routes A through a valid plugin root, B through native root CLAUDE.md, and C through no file", () => {
    const { binding } = runtime();
    const launcher = makeDemo1ClaudeLauncher(binding);
    const skillPlan = launcher.plan(view(demo1ClaudeArmRequirements(binding, "skill")), paths, attempt);
    const baselinePlan = launcher.plan(view(demo1ClaudeArmRequirements(binding, "claude-md")), paths, attempt);
    const noFilePlan = launcher.plan(view(demo1ClaudeArmRequirements(binding, "no-file")), paths, attempt);

    expect(skillPlan.argv).toContain("--plugin-dir");
    expect(skillPlan.argv).toContain(`${paths.work}/${DEMO1_SKILL_PLUGIN_DIRECTORY}`);
    expect(baselinePlan.argv).not.toContain("--plugin-dir");
    expect(noFilePlan.argv).not.toContain("--plugin-dir");
    expect(skillPlan.argv).toContain(DEMO1_CLAUDE_MODEL_ID);
    expect(skillPlan.argv).toContain(DEMO1_CLAUDE_EFFORT);
    expect(skillPlan.cwd).toBe(paths.work);
    expect(DEMO1_SKILL_PATH).toBe(".jinn-demo1-skill-plugin/skills/demo1/SKILL.md");
    expect(DEMO1_CLAUDE_MD_PATH).toBe("CLAUDE.md");
    expect(demo1ClaudeArmRequirements(binding, "no-file")).not.toHaveProperty("loadout");
  });

  it("declares the product's exact model and effort rather than platform wildcards", () => {
    const keys = makeDemo1ClaudeLauncher(runtime().binding).capabilities().runPinning.keys;
    expect(keys.find((entry) => entry.key === "model")?.inventory).toEqual([DEMO1_CLAUDE_MODEL_ID]);
    expect(keys.find((entry) => entry.key === "effort")?.inventory).toEqual([DEMO1_CLAUDE_EFFORT]);
  });

  it("keeps every v2 arm identical except for the frozen instruction loadout", () => {
    const binding = createDemo1ClaudeCandidateRuntimeBinding({
      executablePath: process.execPath,
      harnessVersion: HARNESS_VERSION,
      artifacts,
      candidateIndex: 0,
      command: async () => ({ stdout: "" }),
    });
    const skill = demo1ClaudeArmRequirements(binding, "skill");
    const baseline = demo1ClaudeArmRequirements(binding, "claude-md");
    const noFile = demo1ClaudeArmRequirements(binding, "no-file");
    const withoutLoadout = (requirements: Readonly<Record<string, unknown>>) => {
      const { loadout: _loadout, ...shared } = requirements;
      return shared;
    };
    expect(withoutLoadout(skill)).toEqual(withoutLoadout(baseline));
    expect(withoutLoadout(skill)).toEqual(noFile);
    expect(skill).toMatchObject({ model: { id: "claude-haiku-4-5-20251001" }, effort: "low" });
    expect(skill.loadout).toBe(artifacts.skill);
    expect(baseline.loadout).toBe(artifacts.baseline);
    expect(noFile).not.toHaveProperty("loadout");
  });
});
