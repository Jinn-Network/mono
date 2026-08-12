import { canonicalLoadoutPin, type LoadoutKind } from "@jinn-network/task-execution-workspace";
import {
  documentDigest,
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/task-execution-protocol";

export interface VerifiedExecutable {
  readonly path: string;
  readonly digest: string;
}

export interface LauncherReadiness {
  readonly ready: boolean;
  readonly detail?: string;
  readonly executable: VerifiedExecutable;
  readonly harnessVersions?: readonly string[];
  readonly models?: readonly string[];
  readonly loadouts?: readonly {
    readonly kind: LoadoutKind;
    readonly name: string;
    readonly digest: string;
  }[];
}

export interface LocalLauncherDeployment {
  readonly executable: VerifiedExecutable;
  probe(): Promise<LauncherReadiness>;
}

export interface RunPinningCheck {
  readonly ready: boolean;
  readonly detail?: string;
  /** Exact JCS digest of the run-owned pinning map this result is issued against. */
  readonly checkedRequirementsDigest: `sha256:${string}`;
}

/** The exact identity used by benchmarking's pinning bridge to bind a check to one map. */
export function checkedRequirementsDigest(
  requirements: Readonly<Record<string, unknown>>,
): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson(requirements as JsonValue));
}

// canonicalLoadoutPin already enforces the kind-appropriate digest spelling (bare hex for
// jinn.skill.v1, sha256:-prefixed for jinn.harness-state.v1 — F9,
// packages/task-execution/backend-local/workspace/src/sha256-digest.ts); this is a defensive
// re-check on the already-parsed value, so it accepts both forms rather than picking one.
function isDigest(value: unknown): value is string {
  return typeof value === "string" && (/^[0-9a-f]{64}$/u.test(value) || /^sha256:[0-9a-f]{64}$/u.test(value));
}

/** The deployment probe is the sole dynamic admission boundary for enforced local pins. */
export async function verifyRunPinning(
  deployment: LocalLauncherDeployment,
  requirements: Readonly<Record<string, unknown>>,
  /** The run-owned merged pinning map whose identity the caller will later grade. The backend
   * may enforce a richer effective requirements map (the second argument); those unrelated
   * profile/task requirements must not make an otherwise exact run-pinning receipt unusable. */
  checkedRequirements: Readonly<Record<string, unknown>> = requirements,
): Promise<RunPinningCheck> {
  const checkedDigest = checkedRequirementsDigest(checkedRequirements);
  const rejected = (detail: string): RunPinningCheck => ({
    ready: false,
    detail,
    checkedRequirementsDigest: checkedDigest,
  });
  const readiness = await deployment.probe();
  if (!readiness.ready) return rejected(readiness.detail ?? "launcher readiness probe failed");
  if (
    readiness.executable.path !== deployment.executable.path
    || readiness.executable.digest !== deployment.executable.digest
  ) return rejected("executable identity mismatch");

  const harness = requirements.harness;
  if (harness !== undefined) {
    if (typeof harness !== "object" || harness === null) return rejected("harness pin is invalid");
    const record = harness as { version?: unknown; digest?: unknown };
    if (record.digest !== undefined && record.digest !== deployment.executable.digest) return rejected("harness digest mismatch");
    if (record.version !== undefined && (
      typeof record.version !== "string" || !readiness.harnessVersions?.includes(record.version)
    )) return rejected("harness version mismatch");
  }
  const model = requirements.model;
  if (model !== undefined) {
    const id = typeof model === "object" && model !== null ? (model as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !readiness.models?.includes(id)) return rejected("model pin mismatch");
  }
  const loadout = requirements.loadout;
  if (loadout !== undefined) {
    let pin;
    try {
      pin = canonicalLoadoutPin(loadout);
    } catch {
      return rejected("loadout path is not contained");
    }
    if (!isDigest(pin.digest)) return rejected("loadout digest is invalid");
    if (!readiness.loadouts?.some((entry) =>
      entry.kind === pin.kind && entry.name === pin.name && entry.digest === pin.digest)) {
      return rejected("loadout digest mismatch");
    }
  }
  return { ready: true, checkedRequirementsDigest: checkedDigest };
}
