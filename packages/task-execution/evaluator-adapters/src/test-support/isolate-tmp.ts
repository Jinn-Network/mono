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
// This file is duplicated verbatim in `packages/benchmark-product/core`. Two ~30-line copies are
// deliberately cheaper than a shared workspace package with its own build, portal resolutions and
// publish surface. Graduate it to one at a third consumer.
import { mkdtempSync, rmSync } from "node:fs";
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

// Named rather than an inline arrow so `tmp-isolation.test.ts` can find it in
// `process.listeners("exit")` and go red if the teardown is dropped.
function jinnTestTmpdirSweep(): void {
  rmSync(managedRoot, { recursive: true, force: true });
}

afterAll(jinnTestTmpdirSweep);
process.on("exit", jinnTestTmpdirSweep);
