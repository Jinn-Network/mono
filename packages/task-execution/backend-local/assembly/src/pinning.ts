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
  readonly loadouts?: readonly { readonly path: string; readonly digest: string }[];
}

export interface LocalLauncherDeployment {
  readonly executable: VerifiedExecutable;
  probe(): Promise<LauncherReadiness>;
}

export interface RunPinningCheck {
  readonly ready: boolean;
  readonly detail?: string;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function containedLoadoutPath(input: string, name: unknown): string | undefined {
  if (
    typeof name !== "string" || name.length === 0 || name === "." || name === ".."
    || name.includes("/") || name.includes("\\")
  ) return undefined;
  return `${input}/${name}`;
}

/** The deployment probe is the sole dynamic admission boundary for enforced local pins. */
export async function verifyRunPinning(
  deployment: LocalLauncherDeployment,
  requirements: Readonly<Record<string, unknown>>,
  inputPath: string,
): Promise<RunPinningCheck> {
  const readiness = await deployment.probe();
  if (!readiness.ready) return { ready: false, detail: readiness.detail ?? "launcher readiness probe failed" };
  if (
    readiness.executable.path !== deployment.executable.path
    || readiness.executable.digest !== deployment.executable.digest
  ) return { ready: false, detail: "executable identity mismatch" };

  const harness = requirements.harness;
  if (harness !== undefined) {
    if (typeof harness !== "object" || harness === null) return { ready: false, detail: "harness pin is invalid" };
    const record = harness as { version?: unknown; digest?: unknown };
    if (record.digest !== undefined && record.digest !== deployment.executable.digest) return { ready: false, detail: "harness digest mismatch" };
    if (record.version !== undefined && (
      typeof record.version !== "string" || !readiness.harnessVersions?.includes(record.version)
    )) return { ready: false, detail: "harness version mismatch" };
  }
  const model = requirements.model;
  if (model !== undefined) {
    const id = typeof model === "object" && model !== null ? (model as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !readiness.models?.includes(id)) return { ready: false, detail: "model pin mismatch" };
  }
  const loadout = requirements.loadout;
  if (loadout !== undefined) {
    const record = typeof loadout === "object" && loadout !== null ? loadout as {
      kind?: unknown; name?: unknown; digest?: { sha256?: unknown };
    } : undefined;
    const path = containedLoadoutPath(inputPath, record?.name);
    if (record?.kind !== "jinn.skill.v1" || path === undefined) return { ready: false, detail: "loadout path is not contained" };
    if (!isDigest(record.digest?.sha256)) return { ready: false, detail: "loadout digest is invalid" };
    if (!readiness.loadouts?.some((entry) => entry.path === path && entry.digest === record.digest?.sha256)) {
      return { ready: false, detail: "loadout digest mismatch" };
    }
  }
  return { ready: true };
}
