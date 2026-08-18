// Removal of a throwaway tree the suite owns. Both halves of the temp isolation call it: the
// per-test-file sweep in `isolate-tmp.ts` and the per-run sweep in `global-tmp-root.ts`. One copy
// so the two teardowns cannot drift apart.
//
// `rmSync` cannot remove a read-only directory — `unlink` needs the write bit on the *parent*
// directory, and `force: true` only suppresses ENOENT, never EACCES — and the local workspace
// provisioner seals each attempt's `input/` exactly that way (directories 0o500, files 0o400) to
// protect a live attempt's dispatch context from the solver process. That seal is a runtime
// integrity property, not a durability guarantee about test scratch space: it holds for the whole
// life of every test, and a sweep runs only after the last assertion. The per-run sweep meets the
// same seal whenever a worker died before its own sweep could run, so both halves need the repair.
//
// This file is duplicated verbatim in `packages/task-execution/evaluator-adapters`, alongside the
// other two files of this seam. Graduate the set to a shared package at a third consumer.
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Names the trees this suite owns. `isolate-tmp.ts` creates with it, and the per-run teardown in
 * `global-tmp-root.ts` admits a recorded path for recursive removal only if it starts with it. The
 * two have to move together: a rename that reached only the creator would leave the guard
 * rejecting every real root, turning the per-run sweep into a silent no-op.
 */
export const MANAGED_ROOT_PREFIX = "jinn-vitest-tmp-";

// Restores write and traverse permission on the tree. Symlinks are skipped — `chmod` follows them,
// which would reach outside the tree, and `rmSync` unlinks them without needing the target's
// permission.
function unsealTree(directory: string): void {
  let entries;
  try {
    chmodSync(directory, 0o700);
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return; // Let the retry in the caller report whatever actually blocks removal.
  }
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) unsealTree(child);
    else {
      try {
        chmodSync(child, 0o600);
      } catch {
        // Same: the retry's error is the useful one.
      }
    }
  }
}

/**
 * Removes `root`, repairing a sealed subtree and retrying once. Never throws: a cleanup failure is
 * an operational problem that has to be visible, yet throwing would fabricate a failure in a test
 * file whose assertions all passed. `label` names the tree in that warning.
 */
export function sweepManagedTree(root: string, label: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Almost always a sealed `input/`. Unseal the tree we own, then retry.
    unsealTree(root);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[jinn-test] could not sweep ${label} ${root}:`, error);
    }
  }
}
