import {
  acquireRunPublicationGuard,
  type RunFinalizationLockDeps,
} from "./finalization-lock.js";

export interface PublicationLock {
  release(): void;
}

export interface PublicationLockDeps extends RunFinalizationLockDeps {}

/**
 * Cross-process async publication mutex. Canonical ownership, dead-owner recovery, PID reuse,
 * tri-state liveness, and exact token/inode/directory release are all delegated to the same
 * fenced protocol used by run finalization; this wrapper only supplies bounded async retry.
 */
export async function acquirePublicationLock(
  workspaceDir: string,
  draftId: string,
  timeoutMs = 30_000,
  deps: PublicationLockDeps = {},
): Promise<PublicationLock> {
  const started = Date.now();
  while (true) {
    const result = acquireRunPublicationGuard(workspaceDir, draftId, deps);
    if (result.acquired) return { release: result.release };
    if (result.reason !== "contended") {
      throw new Error(`publication lock is ${result.reason}: ${result.detail}`);
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for publication lock for ${draftId}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
