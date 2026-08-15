// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  prefixedDigest,
  type JsonValue,
} from "@jinn-network/policy-identity";
import type {
  LauncherCapabilities,
  LauncherContract,
  LaunchPlan,
} from "@jinn-network/task-execution-launchers";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { REPOSITORY_WORK_PROFILE_URI } from "@jinn-network/task-execution-profiles";
import type { PinnedHarness } from "./swe-rebench-journey.js";
import { HostStateError } from "./state.js";

export const LIVE_SOLVER_WRAPPER_TOKEN =
  "network.jinn.policy-optimization.local-solver-wrapper/1.0" as const;
export const LIVE_SOLVER_AUTH_GRANT = "solver-session" as const;
export const LIVE_SOLVER_AUTH_TARGET = "codex-auth.json" as const;

export interface LiveSolverLauncherInput {
  readonly harness: PinnedHarness;
  readonly model: string;
  readonly path: string;
  readonly wrapperEntrypoint?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostStateError("state-io", `${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function exactRequirements(view: TaskView, input: LiveSolverLauncherInput): {
  readonly loadoutName: string;
  readonly loadoutDigest: string;
} {
  const requirements = record(view.effectiveRequirements, "solver requirements");
  const harness = record(requirements["harness"], "solver harness pin");
  const model = record(requirements["model"], "solver model pin");
  const loadout = record(requirements["loadout"], "solver loadout pin");
  if (harness["id"] !== input.harness.id
    || harness["version"] !== input.harness.version
    || harness["digest"] !== input.harness.digest
    || model["id"] !== input.model
    || requirements["isolationPolicy"] !== "unrestricted"
    || loadout["kind"] !== "jinn.harness-state.v1"
    || typeof loadout["name"] !== "string"
    || typeof loadout["digest"] !== "string") {
    throw new HostStateError("state-io", "solver route moved from the exact prepared pin set");
  }
  return { loadoutName: loadout["name"], loadoutDigest: loadout["digest"] };
}

function capabilities(input: LiveSolverLauncherInput): LauncherCapabilities {
  return {
    taskProfiles: [REPOSITORY_WORK_PROFILE_URI],
    inputMediaTypes: ["application/json", "text/plain"],
    outputMediaTypes: ["text/x-diff"],
    structuredOutput: false,
    resume: false,
    interruptionBehaviorDefault: "nonrepeatable",
    secretForwards: [{ grantKey: LIVE_SOLVER_AUTH_GRANT, target: LIVE_SOLVER_AUTH_TARGET }],
    runPinning: {
      keys: [
        { key: "harness", inventory: [input.harness.id], posture: "enforced" },
        { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
        { key: "loadout", inventory: ["jinn.harness-state.v1"], posture: "enforced" },
        { key: "model", inventory: [input.model], posture: "enforced" },
      ],
    },
  };
}

function plan(
  input: LiveSolverLauncherInput,
  view: TaskView,
  paths: WorkspacePaths,
  attempt: AttemptIdentity,
): LaunchPlan {
  if (view.profile.profile !== REPOSITORY_WORK_PROFILE_URI) {
    throw new HostStateError("state-io", "live solver launcher accepts repository-work only");
  }
  const pins = exactRequirements(view, input);
  const wrapper = input.wrapperEntrypoint
    ?? fileURLToPath(new URL("./solver-process.js", import.meta.url));
  return {
    argv: [process.execPath, wrapper],
    cwd: paths.work,
    env: {
      JINN_ATTEMPT_ID: attempt.attemptUri,
      JINN_ATTEMPT_INPUT: paths.input,
      JINN_ATTEMPT_LOGS: paths.logs,
      JINN_ATTEMPT_OUT: paths.out,
      JINN_ATTEMPT_SECRETS: paths.secrets,
      JINN_ATTEMPT_HARNESS_STATE: paths.harnessState,
      JINN_ATTEMPT_WORK: paths.work,
      TMPDIR: paths.tmp,
      JINN_SOLVER_AUTH_FILE: `${paths.secrets}/${LIVE_SOLVER_AUTH_TARGET}`,
      JINN_SOLVER_EXECUTABLE: input.harness.executable,
      JINN_SOLVER_HARNESS: input.harness.id,
      JINN_SOLVER_LOADOUT: `${paths.input}/${pins.loadoutName}`,
      JINN_SOLVER_LOADOUT_DIGEST: pins.loadoutDigest,
      JINN_SOLVER_MODEL: input.model,
      JINN_SOLVER_PATH: input.path,
    },
    validExitCodes: [0],
    blameExitCodes: [
      { match: { exitCode: 70 }, blame: "infrastructure", reasonCode: "solver-wrapper-failed" },
      { match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "solver-killed" },
    ],
    resultContract: { envelopeFormat: "jinn-local-solver-wrapper-v1" },
    interruptionBehavior: "nonrepeatable",
    secretForwards: [{ grantKey: LIVE_SOLVER_AUTH_GRANT, target: LIVE_SOLVER_AUTH_TARGET }],
  };
}

/** Private loadout-aware launcher. Only the jinn-optimize host composes it. */
export function makeLiveSolverLauncher(input: LiveSolverLauncherInput): LauncherContract {
  if (input.harness.id !== "codex") {
    throw new HostStateError("state-io", "the first live solver slice supports the codex harness only");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.harness.digest)
    || input.harness.version.length === 0 || input.model.length === 0 || input.path.length === 0) {
    throw new HostStateError("state-io", "live solver launcher requires exact harness, model, and PATH pins");
  }
  return Object.freeze({
    id: input.harness.id,
    capabilities: () => capabilities(input),
    probe: async () => ({ ready: true }),
    plan: (view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity) =>
      plan(input, view, paths, attempt),
  });
}

/** Stable host implementation identity recorded beside the prepared run plan. */
export function liveSolverWrapperDigest(): string {
  return prefixedDigest(canonicalJsonBytes({
    authGrant: LIVE_SOLVER_AUTH_GRANT,
    authTarget: LIVE_SOLVER_AUTH_TARGET,
    formatToken: LIVE_SOLVER_WRAPPER_TOKEN,
    output: "patch",
    profile: REPOSITORY_WORK_PROFILE_URI,
  } as JsonValue));
}
