// Suite-wide home isolation. Wired as the Vitest `setupFiles` entry in `vitest.config.ts`.
//
// `loadConfig()` with no argument falls back to `~/.jinn-client/config.json`, and since the
// stage-1 shape-v2 migration that fallback path is WRITTEN as well as read. Several tests call
// `loadConfig()` with no argument to assert defaults, so running the suite on a developer's
// machine read — and then migrated — their real operator config.
//
// A setup file runs before any test module is imported, so it wins over the module-level
// `homedir()` captures in `src/config.ts` (`DEFAULT_DIR`, `DEFAULT_CONFIG_PATH`, `earningDir`,
// `dbPath`, …). `os.homedir()` consults `$HOME` on POSIX and `$USERPROFILE` on Windows, so
// pointing both at a temp directory makes the real home unreachable for every test, current and
// future. A test that wants its own home still sets one explicitly and wins; this is only the
// floor.
//
// Vitest re-evaluates setup files per test file (default `isolate: true`), so each test file
// gets its own empty home — nothing a test seeds can leak into a sibling file.
//
// This module exports NOTHING on purpose. The isolation must come from the `setupFiles` wiring,
// not from an import: a test that imported this module would trigger the override itself and so
// could not detect the wiring being removed. The two paths are published as environment
// variables instead — see `test/config/home-isolation.test.ts`, which asserts on them and goes
// red if the wiring disappears.
//
// The same seam also owns the suite's temp directories. `$TMPDIR` is redirected at a `tmp/`
// subdirectory of the isolated home, and Node re-reads `$TMPDIR` on every `os.tmpdir()` call, so
// every `mkdtemp(join(tmpdir(), …))` in the suite — current and future — lands inside the
// isolated home by construction. Removing the home therefore removes every temp directory the
// test file created, without a per-call-site cleanup that a failing test would skip anyway.
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
// closes the remaining cases: this file records its home there, and the per-run teardown removes
// every recorded home from the main process once the workers are gone. The second sweep here
// is a no-op (`force: true` on a missing path), which is why keeping the partial backstop is free.
//
// The sweep repairs permissions before giving up, and stands down under a keep-artifact flag — see
// `sweep-tree.ts`. The same two behaviours are carried by the shared package-side seam in
// `test-support/tmp-isolation/`, which every Vitest suite under `packages/` wires, so both sweeps
// behave identically. That seam isolates `$TMPDIR` only; this one isolates `$HOME` as well, which
// is why the operator keeps its own.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterAll } from 'vitest';

import { ISOLATED_HOME_PREFIX, assertSocketSafeRoot, sweepManagedTree } from './sweep-tree.js';

const realHome = homedir();

// The host temp directory, as published by `global-tmp-root.ts` before any worker was forked,
// rather than whatever `tmpdir()` reports here. Two reasons: it is the same base the per-run guard
// checks records against, so the writer's base and the reader's base cannot diverge; and a REUSED
// worker — `--no-isolate`, where this file is evaluated again in a process whose `$TMPDIR` was
// already redirected into the previous, by-then-swept home — would otherwise try to create its
// next home inside a directory that no longer exists. Falls back to `tmpdir()` for a single-file
// run under a config with no `globalSetup` entry.
const hostTmpdir = process.env['JINN_TEST_HOST_TMPDIR'] ?? tmpdir();
const isolatedHome = mkdtempSync(join(hostTmpdir, ISOLATED_HOME_PREFIX));

// Record this home with the per-run teardown in `global-tmp-root.ts`, which removes every
// recorded tree once the workers are gone — the only thing that cleans up after a file whose
// tests are all skipped, since such a file never fires the `afterAll` below. Written immediately
// after the home exists, so the unrecorded window is as short as it can be. Registering rather
// than nesting keeps `$TMPDIR` at its current length, which the spawned-subprocess tests depend
// on; `global-tmp-root.ts` explains why that matters. Best-effort by design: a single file run
// under a config with no `globalSetup` entry has nowhere to record, and still works.
const runRegistry = process.env['JINN_TEST_RUN_TMPDIR'];
if (runRegistry !== undefined) {
  try {
    writeFileSync(join(runRegistry, basename(isolatedHome)), isolatedHome);
  } catch {
    // A missing or stale registry is not worth failing a test file over; the `afterAll` below is
    // still the normal path, and an unswept empty home is the pre-existing behaviour.
  }
}

process.env['HOME'] = isolatedHome;
process.env['USERPROFILE'] = isolatedHome;

/** The temp directory standing in for `~` in this test file. */
process.env['JINN_TEST_ISOLATED_HOME'] = isolatedHome;
/** The operator's real home, captured before the override, so tests can assert they missed it. */
process.env['JINN_TEST_REAL_HOME'] = realHome;

const isolatedTmp = join(isolatedHome, 'tmp');

// Fail here, naming `$TMPDIR`, rather than let a long host temp directory surface as an EEXIST or
// EADDRINUSE inside whichever test spawns a subprocess — see the budget in `sweep-tree.ts`.
// Checked after the home is registered above, so the run teardown still removes it.
assertSocketSafeRoot(isolatedTmp, hostTmpdir);

// 0o700 as defence in depth. Containment already holds — the parent is a `mkdtemp` home, which is
// 0o700 — but the default umask would otherwise leave this directory itself group- and
// world-readable, and every temp directory the test file creates lands inside it.
mkdirSync(isolatedTmp, { mode: 0o700 });

// No trailing separator: `os.tmpdir()` strips one on POSIX, and the exact string equality is
// what `test/config/tmp-isolation.test.ts` asserts on. `TMP`/`TEMP` are set alongside `TMPDIR`
// for Windows parity, the same way `USERPROFILE` is set alongside `HOME` above.
process.env['TMPDIR'] = isolatedTmp;
process.env['TMP'] = isolatedTmp;
process.env['TEMP'] = isolatedTmp;

/** The temp directory every `mkdtemp(join(tmpdir(), …))` in this test file lands inside. */
process.env['JINN_TEST_TMPDIR'] = isolatedTmp;

// Named rather than an inline arrow so `test/config/tmp-isolation.test.ts` can find it in
// `process.listeners('exit')` and go red if the teardown is dropped. Registered before the guard
// below so a guard throw does not itself leak the home.
function jinnTestHomeSweep(): void {
  sweepManagedTree(isolatedHome, 'isolated home');
}

afterAll(jinnTestHomeSweep);
process.on('exit', jinnTestHomeSweep);

// Fail loudly rather than let a test file run against the operator's real home. This runs once
// per test file, so a platform or Node change that stops `homedir()` honouring the environment
// breaks the whole suite instead of quietly rewriting `~/.jinn-client/config.json`.
if (homedir() !== isolatedHome) {
  throw new Error(
    `test home isolation failed: homedir() is ${homedir()}, expected ${isolatedHome}. ` +
      'No test may reach the real ~/.jinn-client.',
  );
}
