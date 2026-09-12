// SPDX-License-Identifier: Apache-2.0

import { rmSync } from "node:fs";

// A recursive `rmSync` walks the tree as readdir -> unlink -> rmdir, so a file that lands in a
// directory between its readdir and its rmdir makes the rmdir fail with ENOTEMPTY; `force: true`
// suppresses only ENOENT. The shim cases hand `meta/` to the shim, which is a separate process
// that keeps publishing there after the one artifact a case awaited -- `custody.json` and
// `cancellation-result.json` arrive later -- so teardown races it, and that race turned a green
// run red on an unrelated markdown-only pull request (issue #2678).
//
// `rmSync`'s own `maxRetries`/`retryDelay` do NOT cover it, which is the whole reason this loop
// exists. Measured on Node 22: when the internal rimraf meets ENOTEMPTY it removes the children it
// read, then retries the bare `rmdir` on its retry schedule WITHOUT re-reading the directory, so
// an entry created after that readdir is never unlinked and every retry fails on it. At
// `maxRetries: 60, retryDelay: 50` a 300ms writer produced a throw after 92 seconds of retrying --
// slower and no more correct. Re-entering `rmSync` from the top is what re-reads the directory.
//
// One budget for the WHOLE hook, not one per directory. The hostile-documents case registers
// eight trees, so a per-directory budget multiplies by eight and a hook that overruns Vitest's
// 10s default hook timeout is the same false red this change exists to remove. Every tree still
// gets at least one attempt whatever the clock says, because the deadline is only consulted after
// a failure.
export const REMOVE_BUDGET_MS = 4_000;
export const REMOVE_POLL_MS = 20;

// `afterEach` is synchronous, and a worker may block: a bounded synchronous wait keeps the
// teardown one statement instead of making every caller async. One buffer, since nothing ever
// stores into it and the wait therefore always runs to its timeout.
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => {
  Atomics.wait(waitCell, 0, 0, ms);
};

/**
 * Removes one attempt tree, re-entering `rmSync` until it succeeds or `deadline` passes.
 *
 * Never throws: the assertions have already passed by the time this runs, so failing the file here
 * reports a defect the test did not find. It is warned about instead -- and nothing leaks either
 * way, because `$TMPDIR` is the managed root that `test-support/tmp-isolation` sweeps when the run
 * ends. Same contract as `sweepManagedTree` in that seam, which this module cannot import: every
 * package tsconfig here sets `rootDir: "src"`.
 *
 * Guarantees at least one attempt, never a retry after the deadline. The loop consults `deadline`
 * only after a failed pass, so every tree gets one attempt whatever the clock says -- the right
 * guarantee under a budget shared by the whole hook. The corollary is that a single pass slower
 * than the remaining budget yields ZERO retries: the loop warns and returns having tried exactly
 * once. That is left as it is deliberately. Guaranteeing a post-deadline retry costs an extra
 * removal pass of unknown size, and the budget exists to hold `afterEach` under Vitest's 10s
 * default hook timeout -- overrunning it is the very false red this machinery removed (issue
 * #2678).
 */
export const removeAttemptTree = (dir: string, deadline = Date.now() + REMOVE_BUDGET_MS): void => {
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        console.warn(`[jinn-test] could not remove attempt tree ${dir}:`, error);
        return;
      }
      sleepSync(REMOVE_POLL_MS);
    }
  }
};
