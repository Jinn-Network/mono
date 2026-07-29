import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskProfileDocument } from "@jinn-network/task-execution-profiles";
import { TASK_PROFILE_FORMAT_URI } from "@jinn-network/task-execution-profiles";
import type { EffectiveRequirements, TaskSpecification } from "@jinn-network/task-execution-protocol";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { describe, expect, it } from "vitest";
import type { LaunchPlan, LauncherContract } from "./contract.js";

// A conforming stub launcher, authored against the A2 contract TYPES before any real
// implementation exists (plan Task A2 Step 1) — proves the contract is shaped correctly and
// pins the "launcher is a pure function, never a state machine" invariant (design §8.4).

const task: TaskSpecification = {
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  profile: { uri: "https://jinn.network/task-profiles/repository-work/1.0", digest: { sha256: "0".repeat(64) } },
  instructions: "stub instructions",
  outputs: [],
};

const effectiveRequirements: EffectiveRequirements = {};

const profile: TaskProfileDocument = {
  protocol: TASK_PROFILE_FORMAT_URI,
  profile: "https://jinn.network/task-profiles/repository-work/1.0",
  description: "stub profile",
  payloadSchema: {},
  inputConventions: { slots: [] },
  outputConventions: { slots: [] },
  evaluationFamilies: [],
  requirementKeys: [],
};

const view: TaskView = { task, effectiveRequirements, profile };

const paths: WorkspacePaths = {
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

const attempt: AttemptIdentity = {
  attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000001",
  nonce: "nonce-1",
  attemptNumber: 1,
};

const FIXED_PLAN: LaunchPlan = {
  argv: ["stub-harness", "--task", "input/task.json"],
  // §8.1: env carries secret forwards as REFERENCES into secrets/ (handles), never resolved
  // values — this is what keeps the journaled plan free of secrets and is what makes plan
  // determinism possible (secret *values* rotate, secret *references* do not).
  env: { STUB_API_KEY: "secrets/api-key", JINN_ATTEMPT_ID: attempt.attemptUri },
  cwd: paths.work,
  validExitCodes: [0],
  blameExitCodes: [{ match: { exitCode: 1 }, blame: "task", reasonCode: "generic-failure" }],
  resultContract: { envelopeFormat: "stub-envelope-v1" },
  interruptionBehavior: "repeatable",
  secretForwards: [{ grantKey: "api-key", target: "api-key" }],
};

const stubLauncher: LauncherContract = {
  id: "stub",
  capabilities: () => ({
    taskProfiles: ["https://jinn.network/task-profiles/repository-work/1.0"],
    inputMediaTypes: ["application/json"],
    outputMediaTypes: ["application/json"],
    structuredOutput: false,
    resume: false,
    interruptionBehaviorDefault: "repeatable",
    secretForwards: [{ grantKey: "api-key", target: "api-key" }],
    runPinning: { keys: [] },
  }),
  // A launcher never spawns, retries, or holds state (§8.4) — `plan` is a pure function of its
  // three inputs, always returning the same fixed plan for this stub.
  plan: () => FIXED_PLAN,
};

describe("LauncherContract (A2 conformance shape)", () => {
  it("plan is a pure function: identical inputs produce a deep-equal plan", () => {
    const first = stubLauncher.plan(view, paths, attempt);
    const second = stubLauncher.plan(view, paths, attempt);
    expect(first).toEqual(second);
  });

  it("env values that reference secrets/ handles are references, not resolved values", () => {
    const plan = stubLauncher.plan(view, paths, attempt);
    expect(plan.env.STUB_API_KEY).toBe("secrets/api-key");
    expect(plan.env.STUB_API_KEY.startsWith("secrets/")).toBe(true);
    // a reference is a handle, not a secret byte sequence — it never looks like the resolved value
    expect(plan.env.STUB_API_KEY).not.toMatch(/^[A-Za-z0-9+/]{20,}=*$/);
  });

  it("blameExitCodes is an ordered first-match rule list, defaulting to task blame when unmatched", () => {
    const plan = stubLauncher.plan(view, paths, attempt);
    expect(plan.blameExitCodes?.[0]).toEqual({ match: { exitCode: 1 }, blame: "task", reasonCode: "generic-failure" });
  });

  it("declares static capabilities without spawning or holding state", () => {
    const capabilities = stubLauncher.capabilities();
    expect(capabilities.taskProfiles).toContain("https://jinn.network/task-profiles/repository-work/1.0");
    expect(typeof stubLauncher.plan).toBe("function");
    expect(stubLauncher.probe).toBeUndefined();
  });
});
