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
// The sweep is registered twice on purpose. `afterAll` is the normal path and runs whether the
// file passed or failed; the `process.on('exit')` listener covers what `afterAll` cannot — a
// test module that throws at import or collection time, so no suite ever runs. Setup files have
// already executed by then, so the listener is installed. The second `rmSync` is a no-op
// (`force: true` on a missing path), which is why the redundancy is free.
//
// The sweep repairs permissions before giving up — see `unsealTree` below. The same repair is
// carried by the two package-level copies of this seam
// (`packages/task-execution/evaluator-adapters` and `packages/benchmark-product/core`,
// `src/test-support/isolate-tmp.ts`), so all three sweeps behave identically.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

const realHome = homedir();
const isolatedHome = mkdtempSync(join(tmpdir(), 'jinn-test-home-'));

process.env['HOME'] = isolatedHome;
process.env['USERPROFILE'] = isolatedHome;

/** The temp directory standing in for `~` in this test file. */
process.env['JINN_TEST_ISOLATED_HOME'] = isolatedHome;
/** The operator's real home, captured before the override, so tests can assert they missed it. */
process.env['JINN_TEST_REAL_HOME'] = realHome;

const isolatedTmp = join(isolatedHome, 'tmp');
mkdirSync(isolatedTmp);

// No trailing separator: `os.tmpdir()` strips one on POSIX, and the exact string equality is
// what `test/config/tmp-isolation.test.ts` asserts on. `TMP`/`TEMP` are set alongside `TMPDIR`
// for Windows parity, the same way `USERPROFILE` is set alongside `HOME` above.
process.env['TMPDIR'] = isolatedTmp;
process.env['TMP'] = isolatedTmp;
process.env['TEMP'] = isolatedTmp;

/** The temp directory every `mkdtemp(join(tmpdir(), …))` in this test file lands inside. */
process.env['JINN_TEST_TMPDIR'] = isolatedTmp;

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

// Named rather than an inline arrow so `test/config/tmp-isolation.test.ts` can find it in
// `process.listeners('exit')` and go red if the teardown is dropped. Registered before the guard
// below so a guard throw does not itself leak the home.
function jinnTestHomeSweep(): void {
  try {
    rmSync(isolatedHome, { recursive: true, force: true });
  } catch {
    // Almost always a sealed `input/`. Unseal the tree we own, then retry.
    unsealTree(isolatedHome);
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch (error) {
      // Loud but not fatal. A cleanup failure is an operational problem that has to be visible,
      // yet throwing here would fabricate a failure in a test file whose assertions all passed.
      console.warn(`[jinn-test] could not sweep isolated home ${isolatedHome}:`, error);
    }
  }
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
