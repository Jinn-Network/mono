// Per-run sweep of the temp roots the workers create. Wired as the Vitest `globalSetup` entry in
// `vitest.config.ts`.
//
// `isolate-home.ts` gives every test *file* its own isolated home and sweeps it in `afterAll`.
// That covers files that pass and files that fail, but not a file whose tests are all skipped:
// Vitest runs no suite there, so no `afterAll` fires and the file's home outlives the run. The
// suite's fully-skipped files therefore left one empty `jinn-test-home-*` directory each behind on
// every `yarn test`, and a hard-killed worker or a Ctrl-C left whatever it had written.
//
// `globalSetup` closes that. It runs in the MAIN process before any worker is forked, and the
// teardown it returns runs there too, after every worker is gone — the one place that can clean up
// after a worker which never reached its own sweep.
//
// It works as a REGISTRY rather than by nesting the homes inside a per-run parent directory, which
// would be the obvious shape. Nesting is not available here: macOS truncates a unix-domain socket
// path at 104 bytes, `spawn`ed children inherit `$TMPDIR`, and the suite spawns `tsx`, which binds
// `$TMPDIR/tsx-<uid>/<pid>.pipe`. That path is already ~93 bytes with the isolated home alone, so
// one more directory level pushes it past the limit, the kernel truncates the pid off the end, and
// two concurrent children collide on the same truncated name (EADDRINUSE). Registering the homes
// instead of containing them keeps every path exactly the length it is today.
//
// A worker records its home by writing one small file here, named after the home's basename. The
// teardown reads them back and removes each recorded tree. A worker killed between creating its
// home and recording it — a window of microseconds — is the one case this cannot cover.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISOLATED_HOME_PREFIX, sweepManagedTree } from './sweep-tree.js';

export default function setup(): () => void {
  const registry = mkdtempSync(join(tmpdir(), 'jinn-test-run-'));

  /** The directory each test file records its isolated home in. */
  process.env['JINN_TEST_RUN_TMPDIR'] = registry;

  function sweepRegisteredRoots(): void {
    let entries: string[];
    try {
      entries = readdirSync(registry);
    } catch {
      return; // Already gone: a second call, or the run root was removed by hand.
    }
    for (const entry of entries) {
      let recorded: string;
      try {
        recorded = readFileSync(join(registry, entry), 'utf8').trim();
      } catch {
        continue; // A half-written record names nothing removable.
      }
      // These paths drive a recursive removal, so only honour what a worker could legitimately
      // have written: something strictly inside the temp directory this process also sees.
      if (recorded.startsWith(join(tmpdir(), ISOLATED_HOME_PREFIX))) {
        sweepManagedTree(recorded, 'isolated home');
      }
    }
    sweepManagedTree(registry, 'per-run temp registry');
  }

  // `vitest run` installs no SIGINT handler of its own: Ctrl-C mid-run kills this process under
  // the default disposition and the teardown below never runs — measured, not assumed. One `once`
  // listener closes that gap. It sweeps and then exits with the same 130 the default disposition
  // would have produced, and because it is `once`, a second Ctrl-C still terminates by default.
  const sweepOnInterrupt = (): void => {
    sweepRegisteredRoots();
    process.exit(130);
  };
  process.once('SIGINT', sweepOnInterrupt);

  return () => {
    process.off('SIGINT', sweepOnInterrupt);
    sweepRegisteredRoots();
  };
}
