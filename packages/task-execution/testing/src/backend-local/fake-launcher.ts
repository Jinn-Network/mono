// SPDX-License-Identifier: Apache-2.0

import type {
  BlameRule,
  LaunchPlan,
  LauncherCapabilities,
  LauncherContract,
  ResultContract,
} from "@jinn-network/task-execution-launchers";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";

/**
 * What a scripted fake run produces — SimpleRunner's role reborn as a contract fixture (design
 * §16). This is consumed IN-PROCESS by whichever fake supervisor/backend a later milestone
 * builds (Milestone A5 onward) to simulate "running" the plan without spawning a real OS
 * process — the fake launcher stays true to `LauncherContract`'s "never spawns" obligation
 * (design §8.4) even in its own test-double form.
 */
export interface FakeLaunchOutcome {
  /** Relative path (within `out/`) -> file content, written by the simulated run. */
  readonly writeOutputs?: Readonly<Record<string, string>>;
  readonly stdout?: string;
  /** The terminal envelope, if any — printed as the harness's own decoded JSON in a real run. */
  readonly envelope?: Readonly<Record<string, unknown>>;
  readonly exitCode: number;
  readonly termSignal?: string | null;
  /** Simulated wall-clock delay before the outcome is produced (for deadline/timing fixtures). */
  readonly delayMs?: number;
}

/**
 * A scripted fake launcher: `plan` is a fixed template merged with the real `(view, paths,
 * attempt)` at `plan()` time (so the resulting `LaunchPlan` is a pure function of its inputs,
 * §16 determinism/hermeticity), and `onRun` is the scripted behavior a fake supervisor invokes
 * in place of actually spawning `plan.argv`.
 */
export interface FakeLaunchScript {
  readonly plan: {
    readonly argvPrefix?: readonly string[];
    readonly validExitCodes: readonly number[];
    readonly blameExitCodes?: readonly BlameRule[];
    readonly resultContract: ResultContract;
    readonly interruptionBehavior: LaunchPlan["interruptionBehavior"];
  };
  readonly capabilities: LauncherCapabilities;
  readonly onRun: (paths: WorkspacePaths) => FakeLaunchOutcome | Promise<FakeLaunchOutcome>;
}

const DEFAULT_CAPABILITIES: LauncherCapabilities = {
  taskProfiles: ["https://jinn.network/task-profiles/repository-work/1.0"],
  inputMediaTypes: ["application/json"],
  outputMediaTypes: ["application/json"],
  structuredOutput: false,
  resume: false,
  interruptionBehaviorDefault: "repeatable",
  runPinning: { keys: [] },
};

/**
 * `makeFakeLauncher(script)` — a contract-conforming `LauncherContract` whose `plan(...)` is
 * PURE and derives its output entirely from `(view, paths, attempt)` plus the closed-over
 * `script` template (never from ambient env, never from I/O): identical inputs produce a
 * byte-identical plan (determinism); mutating `process.env` between calls never changes the
 * output (hermeticity); the same `id`'s launcher instance never accumulates state across calls
 * (statelessness) — the properties `describeLauncherContract` proves generically.
 */
export function makeFakeLauncher(script: FakeLaunchScript): LauncherContract {
  return {
    id: "fake",
    capabilities: () => script.capabilities ?? DEFAULT_CAPABILITIES,
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      return {
        argv: [...(script.plan.argvPrefix ?? ["fake-launcher"]), view.task.instructions],
        // §8.1: env carries secret forwards as REFERENCES into secrets/, never resolved values;
        // this fake never reads a real secret, but it carries the SAME reference-only shape a
        // real launcher must (a literal handle string, not a value) so the contract test's
        // "references, not values" assertion has something meaningful to check.
        env: {
          JINN_ATTEMPT_ID: attempt.attemptUri,
          JINN_ATTEMPT_NONCE: attempt.nonce,
          JINN_FAKE_OUT_DIR: paths.out,
          JINN_FAKE_SECRET_REF: "secrets/fake-handle",
        },
        cwd: paths.work,
        validExitCodes: script.plan.validExitCodes,
        blameExitCodes: script.plan.blameExitCodes,
        resultContract: script.plan.resultContract,
        interruptionBehavior: script.plan.interruptionBehavior,
      };
    },
  };
}
