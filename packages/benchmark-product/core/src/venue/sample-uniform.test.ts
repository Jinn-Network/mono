import { describe, expect, it } from "vitest";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { makeSampleUniformLauncher, SAMPLE_UNIFORM_LAUNCHER_ID } from "./sample-uniform.js";

const PATHS: WorkspacePaths = {
  root: "/attempts/a1",
  input: "/attempts/a1/input",
  work: "/attempts/a1/work",
  out: "/attempts/a1/out",
  logs: "/attempts/a1/logs",
  harnessState: "/attempts/a1/harness-state",
  secrets: "/attempts/a1/secrets",
  tmp: "/attempts/a1/tmp",
  meta: "/attempts/a1/meta",
};

const ATTEMPT: AttemptIdentity = {
  attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000009",
  nonce: "n",
  attemptNumber: 1,
};

function view(effectiveRequirements: Record<string, unknown>): TaskView {
  return { task: {} as TaskView["task"], effectiveRequirements, profile: {} as TaskView["profile"] };
}

describe("makeSampleUniformLauncher", () => {
  it("has the expected id and static capabilities", () => {
    const launcher = makeSampleUniformLauncher();
    expect(launcher.id).toBe(SAMPLE_UNIFORM_LAUNCHER_ID);
    const capabilities = launcher.capabilities();
    expect(capabilities.taskProfiles).toEqual([
      "https://spec.jinn.network/task-profiles/prediction-forecast/1.0",
    ]);
    expect(capabilities.runPinning.keys).toEqual([
      { key: "harness", inventory: ["sample-uniform"], posture: "enforced" },
      { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
    ]);
  });

  it("plans a node -e invocation when unpinned", () => {
    const launcher = makeSampleUniformLauncher();
    const plan = launcher.plan(view({}), PATHS, ATTEMPT);
    expect(plan.argv[0]).toBe(process.execPath);
    expect(plan.argv[1]).toBe("-e");
    expect(typeof plan.argv[2]).toBe("string");
    expect(plan.cwd).toBe(PATHS.work);
    expect(plan.resultContract).toEqual({
      envelopeFormat: "sample-uniform-json",
      structuredOutputArtifact: "out/structured-output.json",
      correlationFields: ["harnessVersion", "sessionId"],
    });
  });

  it("plans successfully when the harness pin selects this launcher", () => {
    const launcher = makeSampleUniformLauncher();
    expect(() => launcher.plan(view({ harness: { id: "sample-uniform" } }), PATHS, ATTEMPT)).not.toThrow();
  });

  it("throws when a harness pin selects a different launcher", () => {
    const launcher = makeSampleUniformLauncher();
    expect(() => launcher.plan(view({ harness: { id: "prediction-v1-baseline" } }), PATHS, ATTEMPT))
      .toThrow(/harness pin does not select this launcher/);
  });

  it("throws when a bare-string harness pin is given (must be an object)", () => {
    const launcher = makeSampleUniformLauncher();
    expect(() => launcher.plan(view({ harness: "sample-uniform" }), PATHS, ATTEMPT))
      .toThrow(/harness pin does not select this launcher/);
  });

  it("plans successfully with isolationPolicy unrestricted", () => {
    const launcher = makeSampleUniformLauncher();
    expect(() => launcher.plan(view({ isolationPolicy: "unrestricted" }), PATHS, ATTEMPT)).not.toThrow();
  });

  it("throws on an unsupported isolationPolicy", () => {
    const launcher = makeSampleUniformLauncher();
    expect(() => launcher.plan(view({ isolationPolicy: "sandboxed" }), PATHS, ATTEMPT))
      .toThrow(/unsupported isolationPolicy/);
  });

  it("defaults probe to ready:true when not configured", async () => {
    const launcher = makeSampleUniformLauncher();
    await expect(launcher.probe!()).resolves.toEqual({ ready: true });
  });
});
