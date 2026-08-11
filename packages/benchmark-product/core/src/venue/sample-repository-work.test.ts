import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { REPOSITORY_WORK_PROFILE_URI } from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import {
  makeSampleRepositoryWorkLauncher,
  SAMPLE_REPOSITORY_WORK_HARNESS_VERSION,
  SAMPLE_REPOSITORY_WORK_LAUNCHER_ID,
} from "./sample-repository-work.js";

const ATTEMPT: AttemptIdentity = {
  attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000000",
  nonce: "n",
  attemptNumber: 1,
};

function paths(root: string): WorkspacePaths {
  return {
    root,
    input: join(root, "input"),
    work: join(root, "work"),
    out: join(root, "out"),
    logs: join(root, "logs"),
    harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"),
    tmp: join(root, "tmp"),
    meta: join(root, "meta"),
  };
}

function view(effectiveRequirements: Record<string, unknown>): TaskView {
  return { task: {} as TaskView["task"], effectiveRequirements, profile: {} as TaskView["profile"] };
}

/** Runs the launcher's real planned argv, exactly as the supervisor would. */
function runPlan(root: string, sealedTask: unknown, workFiles: Record<string, string>) {
  const p = paths(root);
  for (const dir of [p.input, p.work, p.out, p.logs, p.meta, p.tmp]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(p.input, "task.sealed"), JSON.stringify(sealedTask));
  for (const [name, contents] of Object.entries(workFiles)) writeFileSync(join(p.work, name), contents);

  const plan = makeSampleRepositoryWorkLauncher().plan(view({}), p, ATTEMPT);
  const result = execFileSync(plan.argv[0]!, plan.argv.slice(1), {
    cwd: plan.cwd,
    env: plan.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { paths: p, stdout: result };
}

const REPOSITORY_WORK_TASK = { profile: { uri: REPOSITORY_WORK_PROFILE_URI }, payload: { instance_id: "demo__demo-1" } };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

/**
 * A real git repository whose sole tracked file is `f.txt` with exactly `fileContent` as its
 * bytes (no implicit trailing newline is added). This is the repository the emitted patch must
 * apply against.
 */
function makeGitFixture(fileContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sample-repository-work-fixture-"));
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "f.txt"), fileContent);
  git(dir, "add", "f.txt");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

describe("makeSampleRepositoryWorkLauncher", () => {
  it("has the expected id and static capabilities", () => {
    const launcher = makeSampleRepositoryWorkLauncher();
    expect(launcher.id).toBe(SAMPLE_REPOSITORY_WORK_LAUNCHER_ID);
    const capabilities = launcher.capabilities();
    expect(capabilities.taskProfiles).toEqual([REPOSITORY_WORK_PROFILE_URI]);
    expect(capabilities.outputMediaTypes).toContain("text/x-diff");
    expect(capabilities.runPinning.keys).toEqual([
      { key: "harness", inventory: [SAMPLE_REPOSITORY_WORK_LAUNCHER_ID], posture: "enforced" },
      { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
    ]);
  });

  it("defaults probe to ready:true when not configured", async () => {
    await expect(makeSampleRepositoryWorkLauncher().probe!()).resolves.toEqual({ ready: true });
  });

  it("plans a node -e invocation whose cwd is the work tree", () => {
    const plan = makeSampleRepositoryWorkLauncher().plan(view({}), paths("/x"), ATTEMPT);
    expect(plan.argv[0]).toBe(process.execPath);
    expect(plan.argv[1]).toBe("-e");
    expect(typeof plan.argv[2]).toBe("string");
    expect(plan.cwd).toBe("/x/work");
  });

  it("throws when a harness pin selects a different launcher", () => {
    const launcher = makeSampleRepositoryWorkLauncher();
    expect(() => launcher.plan(view({ harness: { id: "sample-uniform" } }), paths("/x"), ATTEMPT))
      .toThrow(/harness pin does not select this launcher/u);
  });

  it("throws on an unsupported isolationPolicy", () => {
    const launcher = makeSampleRepositoryWorkLauncher();
    expect(() => launcher.plan(view({ isolationPolicy: "sandboxed" }), paths("/x"), ATTEMPT))
      .toThrow(/unsupported isolationPolicy/u);
  });

  it("writes a unified diff to out/patch and a structured envelope alongside it", () => {
    const root = mkdtempSync(join(tmpdir(), "sample-repository-work-"));
    const { paths: p } = runPlan(root, REPOSITORY_WORK_TASK, { "README.md": "upstream\n" });

    const patch = readFileSync(join(p.out, "patch"), "utf8");
    expect(patch).toContain("--- a/README.md");
    expect(patch).toContain("+++ b/README.md");
    expect(patch).toContain("+sample-repository-work");

    const envelope = JSON.parse(readFileSync(join(p.out, "structured-output.json"), "utf8")) as {
      status: string; harnessVersion: string;
    };
    expect(envelope.status).toBe("success");
    expect(envelope.harnessVersion).toBe(SAMPLE_REPOSITORY_WORK_HARNESS_VERSION);
  });

  it("is deterministic: the same work tree produces byte-identical patches", () => {
    const first = runPlan(mkdtempSync(join(tmpdir(), "srw-a-")), REPOSITORY_WORK_TASK, { "README.md": "upstream\n" });
    const second = runPlan(mkdtempSync(join(tmpdir(), "srw-b-")), REPOSITORY_WORK_TASK, { "README.md": "upstream\n" });
    expect(readFileSync(join(first.paths.out, "patch"), "utf8"))
      .toBe(readFileSync(join(second.paths.out, "patch"), "utf8"));
  });

  it("exits non-zero when the work tree was never materialized", () => {
    const root = mkdtempSync(join(tmpdir(), "sample-repository-work-empty-"));
    expect(() => runPlan(root, REPOSITORY_WORK_TASK, {})).toThrow();
  });

  it("describes what it actually found when the work tree holds no regular file", () => {
    // A work tree whose root holds only a directory is genuinely materialized -- it is not
    // "never materialized" -- so the error must say what was observed instead of misdiagnosing.
    const root = mkdtempSync(join(tmpdir(), "sample-repository-work-dironly-"));
    const p = paths(root);
    for (const dir of [p.input, p.work, p.out, p.logs, p.meta, p.tmp]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(p.input, "task.sealed"), JSON.stringify(REPOSITORY_WORK_TASK));
    mkdirSync(join(p.work, "subdir"), { recursive: true });

    const plan = makeSampleRepositoryWorkLauncher().plan(view({}), p, ATTEMPT);
    let stderr = "";
    try {
      execFileSync(plan.argv[0]!, plan.argv.slice(1), { cwd: plan.cwd, env: plan.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      throw new Error("expected the runner to exit non-zero");
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? "";
    }
    expect(stderr).toContain("subdir");
    expect(stderr).not.toContain("never materialized");
  });

  describe("emits a patch git apply --check accepts", () => {
    const cases: Array<[name: string, fileContent: string]> = [
      ["file with a trailing newline", "alpha\nbeta\n"],
      ["file without a trailing newline", "alpha\nbeta"],
      ["empty file", ""],
      ["single line with a trailing newline", "solo\n"],
      ["single line without a trailing newline", "solo"],
    ];

    it.each(cases)("%s", (_name, fileContent) => {
      const fixtureDir = makeGitFixture(fileContent);
      const root = mkdtempSync(join(tmpdir(), "sample-repository-work-apply-"));
      const { paths: p } = runPlan(root, REPOSITORY_WORK_TASK, { "f.txt": fileContent });
      const patchPath = join(p.out, "patch");

      expect(() => git(fixtureDir, "apply", "--check", patchPath)).not.toThrow();
    });
  });

  it("exits non-zero when the staged Task is not a repository-work Task", () => {
    const root = mkdtempSync(join(tmpdir(), "sample-repository-work-wrong-"));
    expect(() => runPlan(root, { profile: { uri: "https://spec.jinn.network/task-profiles/prediction-forecast/1.0" } }, { "README.md": "x\n" }))
      .toThrow();
  });
});
