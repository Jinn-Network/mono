import {
  acquireRunPublicationGuard,
  type RunFinalizationLockDeps,
} from "./finalization-lock.js";

export interface PublicationLock {
  release(): void;
}

export interface PublicationLockDeps extends RunFinalizationLockDeps {
  /**
   * Fired at most once, on the first contended attempt. The wait is bounded but long (30s by
   * default), so a caller that prints for an operator needs to say the wait is another process
   * mid-write rather than a hang -- and it can only say that once it knows contention is the
   * cause. The callback is guarded: a diagnostic sink that throws must not fail the acquire.
   */
  readonly onContended?: () => void;
}

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
  let reportedContention = false;
  while (true) {
    const result = acquireRunPublicationGuard(workspaceDir, draftId, deps);
    if (result.acquired) return { release: result.release };
    if (result.reason !== "contended") {
      throw new Error(`publication lock is ${result.reason}: ${result.detail}`);
    }
    if (!reportedContention) {
      reportedContention = true;
      try { deps.onContended?.(); } catch { /* a sink that cannot report is not a reason to fail the acquire */ }
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for publication lock for ${draftId}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
