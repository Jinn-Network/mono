import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { canonicalLoadoutPath, type TaskView, type WorkspacePaths } from "@jinn-network/task-execution-workspace";
import type { LauncherCapabilities, ProbeResult } from "./contract.js";

export interface LauncherOptions {
  readonly probe?: () => Promise<ProbeResult>;
}

export function probeFrom(options: LauncherOptions, id: string): () => Promise<ProbeResult> {
  return options.probe ?? (async () => ({ ready: false, detail: `${id}: binary/auth/version probe port not configured` }));
}

export function requirementRecord(view: TaskView): Record<string, unknown> {
  return view.effectiveRequirements as Record<string, unknown>;
}

export function requireHarness(view: TaskView, id: string): { version?: string; digest?: string } {
  const value = requirementRecord(view).harness;
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || (value as { id?: unknown }).id !== id) {
    throw new Error(`${id}: harness pin does not select this launcher`);
  }
  return value as { version?: string; digest?: string };
}

export function modelId(view: TaskView): string | undefined {
  const value = requirementRecord(view).model;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw new Error("model pin must be an object");
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) throw new Error("model pin requires an id");
  return id;
}

export function isolation(view: TaskView): string | undefined {
  const value = requirementRecord(view).isolationPolicy;
  if (value === undefined) return undefined;
  if (value !== "unrestricted") throw new Error(`unsupported isolationPolicy ${String(value)}`);
  return value;
}

export function effort(view: TaskView): string | undefined {
  const value = requirementRecord(view).effort;
  if (value === undefined) return undefined;
  if (!["low", "medium", "high", "xhigh", "max"].includes(String(value))) throw new Error(`unsupported effort ${String(value)}`);
  return String(value);
}

export function loadoutPath(view: TaskView, paths: WorkspacePaths): string | undefined {
  const value = requirementRecord(view).loadout;
  if (value === undefined) return undefined;
  return canonicalLoadoutPath(paths.input, value);
}

export function schema(view: TaskView): unknown {
  return view.task.outputs.find((output) => output.schema !== undefined)?.schema;
}

export function baseEnv(paths: WorkspacePaths, attempt: AttemptIdentity): Record<string, string> {
  return {
    JINN_ATTEMPT_ID: attempt.attemptUri,
    JINN_ATTEMPT_INPUT: paths.input,
    JINN_ATTEMPT_OUT: paths.out,
    JINN_ATTEMPT_LOGS: paths.logs,
    JINN_ATTEMPT_META: paths.meta,
    TMPDIR: paths.tmp,
  };
}

export function capabilities(
  keys: readonly { key: string; inventory: readonly string[] }[],
  resume: boolean,
  secretForwards: readonly { readonly grantKey: string; readonly target: string }[] = [],
): LauncherCapabilities {
  return {
    taskProfiles: ["https://jinn.network/task-profiles/repository-work/1.0", "https://jinn.network/task-profiles/evaluation-task/1.0"],
    inputMediaTypes: ["application/json", "text/plain"],
    outputMediaTypes: ["application/json", "text/plain", "text/x-diff"],
    structuredOutput: true,
    resume,
    interruptionBehaviorDefault: resume ? "recoverable" : "repeatable",
    secretForwards,
    runPinning: { keys: keys.map((entry) => ({ ...entry, posture: "enforced" })) },
  };
}
