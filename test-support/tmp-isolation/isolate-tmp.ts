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
// This is the ONE copy of the seam. It began as two verbatim copies inside
// `packages/benchmark-product/core` and `packages/task-execution/evaluator-adapters`, whose comments
// recorded the graduation trigger: extract at a third consumer. Every Vitest config under
// `packages/` now wires it, so the copies are gone and this directory is what they all point at.
//
// It lives here rather than in a workspace package on purpose. This repository has no root
// workspace — each package installs on its own with `portal:` resolutions — so a package would cost
// a manifest, a build, a publish surface, a catalog entry and roughly fifty dependency edges to
// deliver three files that are never imported by product code and never published. The Vitest
// `setupFiles`/`globalSetup` entries are plain path strings, so a relative path reaches this
// directory with none of that. `.github/scripts/vitest-tmp-isolation.test.mjs` is what keeps every
// config pointing at it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll } from "vitest";

import { MANAGED_ROOT_PREFIX, assertSocketSafeRoot, sweepManagedTree } from "./sweep-tree.js";

// The host temp directory, as published by `global-tmp-root.ts` before any worker was forked,
// rather than whatever `tmpdir()` reports here. Two reasons: it is the same base the per-run guard
// checks records against, so the writer's base and the reader's base cannot diverge; and a REUSED
// worker — `--no-isolate`, where this file is evaluated again in a process whose `$TMPDIR` was
// already redirected into the previous, by-then-swept root — would otherwise try to create its
// next root inside a directory that no longer exists. Falls back to `tmpdir()` for a single-file
// run under a config with no `globalSetup` entry.
const hostTmpdir = process.env["JINN_TEST_HOST_TMPDIR"] ?? tmpdir();
const managedRoot = mkdtempSync(join(hostTmpdir, MANAGED_ROOT_PREFIX));

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

// Fail here, naming `$TMPDIR`, rather than let a long host temp directory surface as an EEXIST or
// EADDRINUSE inside whichever test spawns a subprocess — see the budget in `sweep-tree.ts`.
// Checked after the root is registered above, so the run teardown still removes it.
assertSocketSafeRoot(managedRoot, hostTmpdir);

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
