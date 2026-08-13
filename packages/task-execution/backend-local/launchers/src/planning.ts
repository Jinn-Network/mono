import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { canonicalLoadoutPath, type TaskView, type WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { isAbsolute } from "node:path";
import type { LauncherCapabilities, ProbeResult } from "./contract.js";

export interface LauncherOptions {
  readonly probe?: () => Promise<ProbeResult>;
  /** Deployment-qualified executable. Absent preserves PATH-based compatibility callers. */
  readonly executablePath?: string;
}

export function executablePath(options: LauncherOptions, fallback: string): string {
  if (options.executablePath === undefined) return fallback;
  if (!isAbsolute(options.executablePath)) throw new Error(`${fallback}: executablePath must be absolute`);
  return options.executablePath;
}

/**
 * A credential file supplied by the platform after the launch intent is durable.  This is
 * deliberately a basename, rather than a path: a planner can only ever publish the stable
 * `secrets/<basename>` handle, never a host path or credential bytes.
 */
export type PortableSecretBasename = string & { readonly __portableSecretBasename: unique symbol };

export type HarnessCredentialMode =
  | { readonly kind: "api-key"; readonly secretBasename: string }
  | { readonly kind: "credential-artifact"; readonly secretBasename: string };

/** Host-selected credential: the handle is opaque and never a requester capability grant. */
export type HarnessHostCredential = HarnessCredentialMode & { readonly handle: string };

const PORTABLE_SECRET_BASENAME = /^[A-Za-z0-9._-]+$/u;

export function portableSecretBasename(value: string): PortableSecretBasename {
  if (!PORTABLE_SECRET_BASENAME.test(value) || value === "." || value === "..") {
    throw new Error("credential secretBasename must be a portable basename");
  }
  return value as PortableSecretBasename;
}

export function credentialReference(value: string): `secrets/${string}` {
  return `secrets/${portableSecretBasename(value)}`;
}

export function credentialForwards(credential: HarnessCredentialMode | undefined): readonly { readonly grantKey: string; readonly target: string }[] {
  if (credential === undefined) return [];
  const basename = portableSecretBasename(credential.secretBasename);
  return [{ grantKey: basename, target: basename }];
}

export function hostCredentialForwards(credential: HarnessHostCredential | undefined): readonly import("./contract.js").HostSecretForwardDeclaration[] {
  if (credential === undefined) return [];
  const basename = portableSecretBasename(credential.secretBasename);
  const handle = portableSecretBasename(credential.handle);
  return [{ handle, target: basename, role: "harness" }];
}

/** The small exec-time helper is the only code which opens a forwarded secret file. */
export function credentialExecArgv(argv: readonly string[]): string[] {
  return [process.execPath, new URL("./credential-exec.mjs", import.meta.url).pathname, "--", ...argv];
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
  taskProfiles: readonly string[] = [
    "https://spec.jinn.network/task-profiles/repository-work/1.0",
    "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
  ],
  hostSecretForwards: readonly import("./contract.js").HostSecretForwardDeclaration[] = [],
): LauncherCapabilities {
  return {
    taskProfiles,
    inputMediaTypes: ["application/json", "text/plain"],
    outputMediaTypes: ["application/json", "text/plain", "text/x-diff"],
    structuredOutput: true,
    resume,
    interruptionBehaviorDefault: resume ? "recoverable" : "repeatable",
    secretForwards,
    ...(hostSecretForwards.length === 0 ? {} : { hostSecretForwards }),
    runPinning: { keys: keys.map((entry) => ({ ...entry, posture: "enforced" })) },
  };
}
