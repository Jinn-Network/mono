import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspacePaths } from "./contract.js";

export class WorkspaceQuotaExceededError extends Error {
  readonly category = "quota-exceeded" as const;
  constructor(readonly usedBytes: number, readonly quotaBytes: number) {
    super(`workspace quota exceeded: ${usedBytes} > ${quotaBytes}`);
  }
}

async function size(path: string): Promise<number> {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const entry of await readdir(path)) total += await size(join(path, entry));
  return total;
}

/** Cumulative data-plane quota check; meta is deliberately excluded/reserved. */
export async function enforceWorkspaceQuota(paths: WorkspacePaths, quotaBytes: number): Promise<void> {
  let used = 0;
  for (const path of [paths.input, paths.work, paths.out, paths.logs, paths.harnessState, paths.secrets, paths.tmp]) {
    try { used += await size(path); } catch { /* absent lifecycle directory counts as zero */ }
  }
  if (used > quotaBytes) throw new WorkspaceQuotaExceededError(used, quotaBytes);
}
