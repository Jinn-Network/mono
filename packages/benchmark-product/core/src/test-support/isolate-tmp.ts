// Suite-wide temp-directory isolation. Wired as the Vitest `setupFiles` entry in
// `vitest.config.ts`.
//
// The suite creates workspace roots with `mkdtemp(join(tmpdir(), …))`. The success paths cleaned
// up after themselves; the failing ones did not, and the leftovers accumulated in the user temp
// directory until the volume filled. Chasing every call site would fix today's leaks and none of
// tomorrow's, so the redirect happens one level down instead: `$TMPDIR` points at a managed root
// created here, Node re-reads `$TMPDIR` on every `os.tmpdir()` call, and one removal therefore
// takes every temp directory the test file created with it.
//
// A setup file runs before any test module is imported, so it wins over module-level `tmpdir()`
// captures in test files. Vitest re-evaluates setup files per test file (default
// `isolate: true`), so each file gets its own root.
//
// The sweep is registered twice on purpose. `afterAll` is the normal path and runs whether the
// file passed or failed; the `process.on("exit")` listener covers what `afterAll` cannot — a test
// module that throws at import or collection time, so no suite ever runs. The second `rmSync` is
// a no-op (`force: true` on a missing path), which is why the redundancy is free.
//
// This module exports NOTHING on purpose. The isolation must come from the `setupFiles` wiring,
// not from an import: a test that imported this module would trigger the redirect itself and so
// could not detect the wiring being removed. The path is published as an environment variable
// instead — see `tmp-isolation.test.ts` next to this file.
//
// This file is duplicated verbatim in `packages/task-execution/evaluator-adapters`. Two ~60-line
// copies are deliberately cheaper than a shared workspace package with its own build, portal
// resolutions and publish surface. Graduate it to one at a third consumer.
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

const managedRoot = mkdtempSync(join(tmpdir(), "jinn-vitest-tmp-"));

// No trailing separator: `os.tmpdir()` strips one on POSIX, and the exact string equality is what
// `tmp-isolation.test.ts` asserts on. `TMP`/`TEMP` are set alongside `TMPDIR` for Windows parity.
process.env["TMPDIR"] = managedRoot;
process.env["TMP"] = managedRoot;
process.env["TEMP"] = managedRoot;

/** The temp directory every `mkdtemp(join(tmpdir(), …))` in this test file lands inside. */
process.env["JINN_TEST_TMPDIR"] = managedRoot;

// Restores write and traverse permission on the throwaway tree this file owns. `rmSync` cannot
// remove a read-only directory — `unlink` needs the write bit on the *parent* directory, and
// `force: true` only suppresses ENOENT, never EACCES — and the local workspace provisioner seals
// each attempt's `input/` exactly that way (directories 0o500, files 0o400) to protect a live
// attempt's dispatch context from the solver process. That seal is a runtime integrity property,
// not a durability guarantee about test scratch space: it holds for the whole life of every test,
// and this runs only after the last assertion. Symlinks are skipped — `chmod` follows them, which
// would reach outside the tree, and `rmSync` unlinks them without needing the target's permission.
function unsealTree(directory: string): void {
  let entries;
  try {
    chmodSync(directory, 0o700);
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return; // Let the retry below report whatever actually blocks removal.
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

// Named rather than an inline arrow so `tmp-isolation.test.ts` can find it in
// `process.listeners("exit")` and go red if the teardown is dropped.
function jinnTestTmpdirSweep(): void {
  try {
    rmSync(managedRoot, { recursive: true, force: true });
  } catch {
    // Almost always a sealed `input/`. Unseal the tree we own, then retry.
    unsealTree(managedRoot);
    try {
      rmSync(managedRoot, { recursive: true, force: true });
    } catch (error) {
      // Loud but not fatal. A cleanup failure is an operational problem that has to be visible,
      // yet throwing here would fabricate a failure in a test file whose assertions all passed.
      console.warn(`[jinn-test] could not sweep managed temp root ${managedRoot}:`, error);
    }
  }
}

afterAll(jinnTestTmpdirSweep);
process.on("exit", jinnTestTmpdirSweep);
