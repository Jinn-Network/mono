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
// The sweep is registered twice, and the two registrations cover measured cases:
//
//   file passes        `afterAll` fires, `exit` does not
//   file fails         `afterAll` fires, `exit` does not
//   file fully skipped NEITHER fires — Vitest runs no suite, so there is no `afterAll`, and the
//                      worker is torn down rather than exiting
//   file throws at     `afterAll` cannot fire; `exit` fires when the worker exits normally, which
//   import time        it does reliably when the file runs alone and only sometimes when other
//                      files share the pool
//
// So `afterAll` is the normal path, the `exit` listener is a best-effort extra for the
// import-time-throw case, and NEITHER covers a fully-skipped file. `global-tmp-root.ts` is what
// closes the remaining cases: this file records its root there, and the per-run teardown removes
// every recorded root from the main process once the workers are gone. The second sweep here
// is a no-op (`force: true` on a missing path), which is why keeping the partial backstop is free.
//
// This module exports NOTHING on purpose. The isolation must come from the `setupFiles` wiring,
// not from an import: a test that imported this module would trigger the redirect itself and so
// could not detect the wiring being removed. The path is published as an environment variable
// instead — see `tmp-isolation.test.ts` next to this file.
//
// This file is duplicated verbatim in `packages/benchmark-product/core`, alongside the other two
// files of this seam (`global-tmp-root.ts` and `sweep-tree.ts`). Three small copies are
// deliberately cheaper than a shared workspace package with its own build, portal resolutions and
// publish surface. Graduate the set to one at a third consumer.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll } from "vitest";

import { MANAGED_ROOT_PREFIX, sweepManagedTree } from "./sweep-tree.js";

const managedRoot = mkdtempSync(join(tmpdir(), MANAGED_ROOT_PREFIX));

// Record this root with the per-run teardown in `global-tmp-root.ts`, which removes every recorded
// tree once the workers are gone — the only thing that cleans up after a file whose tests are all
// skipped, since such a file never fires the `afterAll` below. Written immediately after the root
// exists, so the unrecorded window is as short as it can be. Registering rather than nesting keeps
// `$TMPDIR` at its current length, which spawned-subprocess tests depend on; `global-tmp-root.ts`
// explains why that matters. Best-effort by design: a single file run under a config with no
// `globalSetup` entry has nowhere to record, and still works.
const runRegistry = process.env["JINN_TEST_RUN_TMPDIR"];
if (runRegistry !== undefined) {
  try {
    writeFileSync(join(runRegistry, basename(managedRoot)), managedRoot);
  } catch {
    // A missing or stale registry is not worth failing a test file over; the `afterAll` below is
    // still the normal path, and an unswept empty root is the pre-existing behaviour.
  }
}

// No trailing separator: `os.tmpdir()` strips one on POSIX, and the exact string equality is what
// `tmp-isolation.test.ts` asserts on. `TMP`/`TEMP` are set alongside `TMPDIR` for Windows parity.
process.env["TMPDIR"] = managedRoot;
process.env["TMP"] = managedRoot;
process.env["TEMP"] = managedRoot;

/** The temp directory every `mkdtemp(join(tmpdir(), …))` in this test file lands inside. */
process.env["JINN_TEST_TMPDIR"] = managedRoot;

// Named rather than an inline arrow so `tmp-isolation.test.ts` can find it in
// `process.listeners("exit")` and go red if the teardown is dropped.
function jinnTestTmpdirSweep(): void {
  sweepManagedTree(managedRoot, "managed temp root");
}

afterAll(jinnTestTmpdirSweep);
process.on("exit", jinnTestTmpdirSweep);
