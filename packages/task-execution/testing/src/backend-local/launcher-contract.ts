// SPDX-License-Identifier: Apache-2.0

import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { describe, expect, test } from "vitest";

/** A minimal but genuine `(view, paths, attempt)` triple for exercising a `LauncherContract`. */
export function makeSampleLauncherInputs(overrides?: {
  readonly instructions?: string;
  readonly attemptUri?: `urn:uuid:${string}`;
}): { view: TaskView; paths: WorkspacePaths; attempt: AttemptIdentity } {
  const view: TaskView = {
    task: {
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      profile: { uri: "https://jinn.network/task-profiles/repository-work/1.0", digest: { sha256: "0".repeat(64) } },
      instructions: overrides?.instructions ?? "describeLauncherContract sample instructions",
      outputs: [],
    },
    effectiveRequirements: {},
    profile: {
      protocol: "https://jinn.network/profiles/task-profile/1.0",
      profile: "https://jinn.network/task-profiles/repository-work/1.0",
      description: "describeLauncherContract sample profile",
      payloadSchema: {},
      inputConventions: { slots: [] },
      outputConventions: { slots: [] },
      evaluationFamilies: [],
      requirementKeys: [],
    },
  };
  const paths: WorkspacePaths = {
    root: "/attempts/sample",
    input: "/attempts/sample/input",
    work: "/attempts/sample/work",
    out: "/attempts/sample/out",
    logs: "/attempts/sample/logs",
    harnessState: "/attempts/sample/harness-state",
    secrets: "/attempts/sample/secrets",
    tmp: "/attempts/sample/tmp",
    meta: "/attempts/sample/meta",
  };
  const attempt: AttemptIdentity = {
    attemptUri: overrides?.attemptUri ?? "urn:uuid:00000000-0000-0000-0000-000000000301",
    nonce: "sample-nonce",
    attemptNumber: 1,
  };
  return { view, paths, attempt };
}

/**
 * Plan determinism (design §16): identical `(view, paths, attempt)` inputs must produce a
 * deep-equal `LaunchPlan` — the reference-only secret env is what makes this possible (secret
 * *values* rotate, secret *references* do not).
 */
export function assertPlanDeterministic(launcher: LauncherContract): void {
  const { view, paths, attempt } = makeSampleLauncherInputs();
  const first = launcher.plan(view, paths, attempt);
  const second = launcher.plan(view, paths, attempt);
  expect(second).toEqual(first);
}

/**
 * Hermeticity (design §16): a plan must never vary with ambient environment. Mutates
 * `process.env` between two otherwise-identical `plan(...)` calls and asserts the output is
 * unchanged.
 */
export function assertPlanHermetic(launcher: LauncherContract): void {
  const { view, paths, attempt } = makeSampleLauncherInputs();
  const before = launcher.plan(view, paths, attempt);
  const probes = {
    JINN_TESTING_HERMETICITY_PROBE: "ambient",
    OPENAI_API_KEY: "resolved-openai-secret",
    ANTHROPIC_API_KEY: "resolved-anthropic-secret",
    AWS_SECRET_ACCESS_KEY: "resolved-aws-secret",
    GITHUB_TOKEN: "resolved-github-secret",
  };
  const prior = Object.fromEntries(Object.keys(probes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, probes);
  try {
    const after = launcher.plan(view, paths, attempt);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toMatch(/resolved-(?:openai|anthropic|aws|github)-secret/u);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Statelessness (design §16/§8.4): calling `plan(...)` with DIFFERENT inputs must never leak
 * state from a prior call — this asserts the same launcher instance produces plans that differ
 * exactly where the inputs differ (proving it recomputes fresh each time rather than caching or
 * mutating shared state), and that calling it many times in any order never throws or degrades.
 */
export function assertPlanStateless(launcher: LauncherContract): void {
  const first = makeSampleLauncherInputs({ attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000302" });
  const second = makeSampleLauncherInputs({ attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000303" });
  const planA1 = launcher.plan(first.view, first.paths, first.attempt);
  const planB = launcher.plan(second.view, second.paths, second.attempt);
  const planA2 = launcher.plan(first.view, first.paths, first.attempt);
  expect(planA1).toEqual(planA2);
  expect(planA1).not.toEqual(planB);
}

/**
 * Secret discipline (design §8.1): `env` values carrying a `secrets/`-shaped forward must be
 * literal references (handles), never resolved secret values — checked structurally (a resolved
 * secret value would not look like a `secrets/...` handle).
 */
export function assertSecretEnvAreReferences(launcher: LauncherContract): void {
  const { view, paths, attempt } = makeSampleLauncherInputs();
  const plan = launcher.plan(view, paths, attempt);
  for (const [key, value] of Object.entries(plan.env)) {
    if (/SECRET|TOKEN|KEY/i.test(key) && !/^JINN_ATTEMPT_/.test(key)) {
      expect(value.startsWith("secrets/"), `env.${key} must be a secrets/ reference, got ${JSON.stringify(value)}`).toBe(true);
    }
  }
}

/** Static forwards are the closed declaration a plan may use; file-reading launchers need no env reference. */
export function assertSecretForwardsMatchCapabilities(launcher: LauncherContract): void {
  const { view, paths, attempt } = makeSampleLauncherInputs();
  const declared = launcher.capabilities().secretForwards;
  const planned = launcher.plan(view, paths, attempt).secretForwards ?? [];
  expect(planned).toEqual(declared);
  for (const value of Object.values(launcher.plan(view, paths, attempt).env)) {
    if (!value.startsWith("secrets/")) continue;
    const target = value.slice("secrets/".length);
    expect(declared.filter((forward) => forward.target === target)).toHaveLength(1);
  }
}

/**
 * The launcher-contract conformance suite (design §16). Runs the full determinism/hermeticity/
 * statelessness/secret-discipline assertion set against any `LauncherContract` — proven now
 * against the kit's own fake launcher (Milestone A, Task A3); the v1 launchers (claude-code,
 * codex, hermes, cursor) run it in Milestone B (Tasks B3/B4). Result-interpretation is a
 * fixture-shape-only check here (§8.2's `interpretResult` is a Milestone B, Task B3 module-level
 * export, not part of `LauncherContract` itself — see `fixtures.ts`'s
 * `loadResultInterpretationFixture`).
 */
export function describeLauncherContract(launcher: LauncherContract): void {
  describe(`LauncherContract conformance: ${launcher.id}`, () => {
    test("plan is deterministic", () => assertPlanDeterministic(launcher));
    test("plan is hermetic (ambient env never leaks in)", () => assertPlanHermetic(launcher));
    test("plan is stateless across differing inputs", () => assertPlanStateless(launcher));
    test("secret-shaped env values are references, not resolved values", () => assertSecretEnvAreReferences(launcher));
    test("secret forwards exactly match static capabilities", () => assertSecretForwardsMatchCapabilities(launcher));
  });
}
