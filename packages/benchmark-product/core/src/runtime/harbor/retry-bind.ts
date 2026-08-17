/** Harbor in-job retry starts bind to the next Colophon dispatch; snapshots survive wipe-and-recreate. */
import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { artifactsDir } from "../../workspace/layout.js";
import { readFileIfExistsSync } from "../../fs/atomic.js";
import { sha256Hex } from "../../workspace/sealed-store.js";
import type { HostTerminalFacts } from "@jinn-network/benchmarking-run";

/** Harbor 0.21 default `exclude_exceptions` — Colophon follow-up jobs cover these, not inner retry. */
export const HARBOR_RETRY_EXCLUDED_EXCEPTIONS = new Set([
  "AgentTimeoutError",
  "VerifierTimeoutError",
  "RewardFileNotFoundError",
  "RewardFileEmptyError",
  "VerifierOutputParseError",
]);

export const HARBOR_RETRY_SNAPSHOT_SCHEMA = "jinn.network/benchmark-product/harbor-retry-snapshot/1" as const;

export function harborRetryGenerationTrialId(directory: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 1) throw new TypeError("Harbor retry generation must be a positive integer");
  return `${directory}.g${generation}`;
}

export function harborLiveTrialDirectory(trialId: string): string {
  return trialId.replace(/\.g\d+$/u, "");
}

export function harborRetrySnapshotDir(
  workspaceDir: string,
  runSha256: string,
  cellKey: string,
  dispatch: number,
): string {
  if (!/^[a-f0-9]{64}$/u.test(runSha256)) throw new TypeError("Harbor retry snapshot requires a Run digest");
  if (!Number.isInteger(dispatch) || dispatch < 1) throw new TypeError("Harbor retry snapshot requires a positive dispatch index");
  return join(
    artifactsDir(workspaceDir),
    "harbor",
    "snapshots",
    runSha256,
    sha256Hex(new TextEncoder().encode(cellKey)),
    String(dispatch),
  );
}

export function harborRetryUnscorablePath(workspaceDir: string, attemptUri: string): string {
  return join(artifactsDir(workspaceDir), "harbor", "retry-unscorable", sha256Hex(new TextEncoder().encode(attemptUri)));
}

export function harborTrialExceptionType(result: Readonly<Record<string, unknown>>): string | undefined {
  return typeof result.exception_type === "string" ? result.exception_type
    : typeof result.exceptionType === "string" ? result.exceptionType
    : undefined;
}

export function harborTrialRetryable(result: Readonly<Record<string, unknown>>, maxRetries: number): boolean {
  if (!Number.isInteger(maxRetries) || maxRetries <= 0) return false;
  if (result.status === "success") return false;
  const exceptionType = harborTrialExceptionType(result);
  if (exceptionType !== undefined && HARBOR_RETRY_EXCLUDED_EXCEPTIONS.has(exceptionType)) return false;
  return result.status === "error" || result.status === "failed" || exceptionType !== undefined;
}

export function harborRetryUnscorableFacts(workspaceDir: string, attemptUri: string): HostTerminalFacts | undefined {
  const bytes = readFileIfExistsSync(harborRetryUnscorablePath(workspaceDir, attemptUri));
  if (bytes === undefined) return undefined;
  return { unscorable: true };
}

export async function writeHarborRetryUnscorableMarker(
  workspaceDir: string,
  attemptUri: string,
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  const path = harborRetryUnscorablePath(workspaceDir, attemptUri);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, JSON.stringify({ unscorable: true, ...detail }), { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
}

export async function snapshotHarborTrial(input: {
  readonly workspaceDir: string;
  readonly runSha256: string;
  readonly cellKey: string;
  readonly dispatch: number;
  readonly trialDir: string;
  readonly trialName: string;
}): Promise<boolean> {
  const snapshotDir = harborRetrySnapshotDir(input.workspaceDir, input.runSha256, input.cellKey, input.dispatch);
  const marker = join(snapshotDir, "retry.json");
  if (existsSync(marker)) return false;
  await mkdir(snapshotDir, { recursive: true });
  await cp(input.trialDir, join(snapshotDir, input.trialName), { recursive: true, force: true });
  const document = JSON.stringify({
    schema: HARBOR_RETRY_SNAPSHOT_SCHEMA,
    cellKey: input.cellKey,
    dispatch: input.dispatch,
    trialName: input.trialName,
    at: new Date().toISOString(),
  });
  try {
    await writeFile(marker, document, { flag: "wx", mode: 0o600 });
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    return false;
  }
}
