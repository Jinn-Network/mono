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
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const realHome = homedir();
const isolatedHome = mkdtempSync(join(tmpdir(), 'jinn-test-home-'));

process.env['HOME'] = isolatedHome;
process.env['USERPROFILE'] = isolatedHome;

/** The temp directory standing in for `~` in this test file. */
process.env['JINN_TEST_ISOLATED_HOME'] = isolatedHome;
/** The operator's real home, captured before the override, so tests can assert they missed it. */
process.env['JINN_TEST_REAL_HOME'] = realHome;

// Fail loudly rather than let a test file run against the operator's real home. This runs once
// per test file, so a platform or Node change that stops `homedir()` honouring the environment
// breaks the whole suite instead of quietly rewriting `~/.jinn-client/config.json`.
if (homedir() !== isolatedHome) {
  throw new Error(
    `test home isolation failed: homedir() is ${homedir()}, expected ${isolatedHome}. ` +
      'No test may reach the real ~/.jinn-client.',
  );
}
