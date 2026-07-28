import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import { describe, expect, it } from "vitest";
import { makeFakeLauncher } from "./fake-launcher.js";
import {
  assertPlanDeterministic,
  assertPlanHermetic,
  assertPlanStateless,
  assertSecretEnvAreReferences,
  describeLauncherContract,
  makeSampleLauncherInputs,
} from "./launcher-contract.js";

const fakeLauncher = makeFakeLauncher({
  plan: {
    validExitCodes: [0],
    resultContract: { envelopeFormat: "fake-envelope-v1" },
    interruptionBehavior: "repeatable",
  },
  capabilities: {
    taskProfiles: ["https://jinn.network/task-profiles/repository-work/1.0"],
    inputMediaTypes: ["application/json"],
    outputMediaTypes: ["application/json"],
    structuredOutput: false,
    resume: false,
    interruptionBehaviorDefault: "repeatable",
    runPinning: { keys: [] },
  },
  onRun: () => ({ exitCode: 0, envelope: { subtype: "success" } }),
});

// design §16: "the fake launcher satisfies describeLauncherContract's determinism/hermeticity/
// statelessness assertions -> PASS" — the one full-teeth conformance run in Milestone A
// (Task A3); the supervisor/workspace/backend-level suites stay unexercised skeletons until
// their subjects land in A5/B/C.
describeLauncherContract(fakeLauncher);

describe("makeFakeLauncher itself", () => {
  it("never spawns, never retries, holds no state (design §8.4) — plan() is a plain pure function", () => {
    expect(fakeLauncher.probe).toBeUndefined();
    expect(typeof fakeLauncher.plan).toBe("function");
  });

  it("declares static capabilities", () => {
    const capabilities = fakeLauncher.capabilities();
    expect(capabilities.taskProfiles).toContain("https://jinn.network/task-profiles/repository-work/1.0");
  });

  it("plan output actually varies with its inputs (not a trivial constant)", () => {
    const { view, paths, attempt } = makeSampleLauncherInputs({ attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000501" });
    const other = makeSampleLauncherInputs({ attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000502" });
    const planA = fakeLauncher.plan(view, paths, attempt);
    const planB = fakeLauncher.plan(other.view, other.paths, other.attempt);
    expect(planA.env.JINN_ATTEMPT_ID).not.toBe(planB.env.JINN_ATTEMPT_ID);
  });
});

// The conformance assertions must have real teeth — proven by constructing a DELIBERATELY
// ambient-env-leaking launcher and confirming `assertPlanHermetic` catches it. This is not part
// of the kit's public surface; it is a meta-test proving the kit itself is a meaningful check,
// not a rubber stamp.
function makeAmbientEnvLeakingLauncher(): LauncherContract {
  return {
    id: "ambient-leaking",
    capabilities: () => fakeLauncher.capabilities(),
    plan(view, paths, attempt) {
      const base = fakeLauncher.plan(view, paths, attempt);
      return {
        ...base,
        // Deliberately reads ambient state — a real hermeticity violation.
        env: { ...base.env, LEAKED: process.env.JINN_TESTING_HERMETICITY_PROBE ?? "" },
      };
    },
  };
}

function makeNonDeterministicLauncher(): LauncherContract {
  let counter = 0;
  return {
    id: "non-deterministic",
    capabilities: () => fakeLauncher.capabilities(),
    plan(view, paths, attempt) {
      counter += 1;
      const base = fakeLauncher.plan(view, paths, attempt);
      return { ...base, env: { ...base.env, CALL_COUNT: String(counter) } };
    },
  };
}

describe("the conformance assertions catch a genuinely non-conforming launcher", () => {
  it("assertPlanHermetic fails against a launcher that reads ambient env", () => {
    expect(() => assertPlanHermetic(makeAmbientEnvLeakingLauncher())).toThrow();
  });

  it("assertPlanDeterministic fails against a launcher with hidden mutable state", () => {
    expect(() => assertPlanDeterministic(makeNonDeterministicLauncher())).toThrow();
  });

  it("assertPlanStateless fails against the same hidden-state launcher (repeat call for input A drifts)", () => {
    expect(() => assertPlanStateless(makeNonDeterministicLauncher())).toThrow();
  });

  it("assertSecretEnvAreReferences fails against a launcher forwarding a resolved-looking secret value", () => {
    const badLauncher: LauncherContract = {
      id: "leaky-secret",
      capabilities: () => fakeLauncher.capabilities(),
      plan(view, paths, attempt) {
        const base = fakeLauncher.plan(view, paths, attempt);
        return { ...base, env: { ...base.env, API_KEY_TOKEN: "resolved-value-not-a-reference" } };
      },
    };
    expect(() => assertSecretEnvAreReferences(badLauncher)).toThrow();
  });
});
