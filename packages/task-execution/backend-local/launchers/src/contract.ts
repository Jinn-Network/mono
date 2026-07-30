// SPDX-License-Identifier: Apache-2.0

import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";

/**
 * A launcher's declared `interruptionBehavior` (design §6.3/§10.3, adopted stack-wide by this
 * backend, program §10): whether the same Submission's retry is safe to repeat blind
 * (`repeatable`), safe only via the harness's own resume/session mechanism (`recoverable`), or
 * unsafe to retry at all without new application judgment (`nonrepeatable`).
 */
export const INTERRUPTION_BEHAVIORS = ["repeatable", "recoverable", "nonrepeatable"] as const;
export type InterruptionBehavior = (typeof INTERRUPTION_BEHAVIORS)[number];

/**
 * An ordered first-match exit-code/signal → blame rule (design §8.1). The supervisor needs zero
 * per-harness knowledge to fill the attempt record's blame verdict; unmatched exits outside
 * `LaunchPlan.validExitCodes` default to `blame: "task"`.
 */
export interface BlameRule {
  readonly match: { readonly exitCode?: number; readonly signal?: string };
  readonly blame: "task" | "infrastructure";
  readonly reasonCode: string;
}

/**
 * Structural description of how a launcher decodes the harness's terminal envelope (design
 * §8.2). The concrete decoding lives in each launcher's own `result.ts`-equivalent
 * (Milestone B); this is the plan-carried declaration of the envelope shape/flags a `LaunchPlan`
 * commits to, so the plan stays inspectable and journal-able without executable code.
 */
export interface ResultContract {
  /** A stable identifier for the envelope format this launcher decodes (e.g. `"claude-code-json-subtype"`). */
  readonly envelopeFormat: string;
  /** The structured-output flag this launcher passes through when the task profile declares an output schema (design §8.2), e.g. `"--json-schema"`. */
  readonly outputSchemaFlag?: string;
  /** First-class structured object artifact emitted alongside the terminal envelope. */
  readonly structuredOutputArtifact?: string;
  /** Harness fields copied into attempt correlation annotations. */
  readonly correlationFields?: readonly ("harnessVersion" | "capabilities" | "sessionId")[];
}

/**
 * The resolved invocation a launcher plans and the supervisor spawns through the shim (design
 * §8.1, frozen interface §14 item 8). `env` carries secret forwards as REFERENCES into
 * `secrets/` (handles), never resolved values — the shim resolves them at exec (§6.1 step 4);
 * this is what keeps the journaled plan free of secrets and is also why plan determinism holds
 * (§16 — secret *values* rotate, secret *references* do not).
 */
export interface LaunchPlan {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Exit codes that are non-failing (design §8.1). */
  readonly validExitCodes: readonly number[];
  /** Ordered first-match blame rules (design §8.1); unmatched → `blame: "task"`. */
  readonly blameExitCodes?: readonly BlameRule[];
  readonly resultContract: ResultContract;
  readonly interruptionBehavior: InterruptionBehavior;
  readonly secretForwards?: readonly { readonly grantKey: string; readonly target: string }[];
}

/** A backend's declared enforcement posture for a supported run-pinning key (profiles §5.2) — independently re-implemented here (this package does not depend on `@jinn-network/task-execution-backend`, so it never imports `BackendCapabilities`'s copy). */
export const RUN_PINNING_ENFORCEMENT_POSTURES = ["enforced", "attested"] as const;
export type RunPinningEnforcementPosture = (typeof RUN_PINNING_ENFORCEMENT_POSTURES)[number];

/** One supported run-pinning key and this launcher's inventory + posture for it (design §8.1 two-channel capability declaration, static half). */
export interface LauncherRunPinningKeySupport {
  readonly key: string;
  readonly inventory: readonly string[];
  readonly posture: RunPinningEnforcementPosture;
}

/**
 * A launcher's static capability declaration (design §8.1 two-channel capability declaration).
 * The dynamic half is `LauncherContract.probe()`.
 */
export interface LauncherCapabilities {
  readonly taskProfiles: readonly string[];
  readonly inputMediaTypes: readonly string[];
  readonly outputMediaTypes: readonly string[];
  readonly structuredOutput: boolean;
  readonly resume: boolean;
  readonly interruptionBehaviorDefault: InterruptionBehavior;
  /** Exact non-secret forwards this launcher may require for every planned invocation. */
  readonly secretForwards: readonly { readonly grantKey: string; readonly target: string }[];
  readonly runPinning: { readonly keys: readonly LauncherRunPinningKeySupport[] };
}

/** `LauncherContract.probe()`'s dynamic readiness result (design §8.1 two-channel capability declaration, dynamic half). */
export interface ProbeResult {
  readonly ready: boolean;
  readonly detail?: string;
}

/**
 * The Executor Launcher contract (design §8.1, frozen interface §14 item 8-9). A launcher is a
 * PURE function from `(TaskView, WorkspacePaths, AttemptIdentity)` to a `LaunchPlan` — it never
 * spawns, retries, holds state, or touches secrets beyond declared forwards (design §8.4). This
 * `plan(...)` signature is what couples `launchers` to `TaskView`/`WorkspacePaths` (`workspace`)
 * and `AttemptIdentity` (`supervisor`) — the two intra-tree edges this package declares beyond
 * protocol+profiles (backend plan Finding (e)).
 */
export interface LauncherContract {
  readonly id: string;
  capabilities(): LauncherCapabilities;
  probe?(): Promise<ProbeResult>;
  plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan;
}
