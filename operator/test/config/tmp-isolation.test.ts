import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Safe to import: unlike the setup file, this module performs nothing at import time — the root is
// only created when `setup()` is called. The wiring assertions below still read the environment,
// so deleting the `globalSetup` entry turns this file red.
import globalTmpRootSetup from '../_support/global-tmp-root.js';
import { ISOLATED_HOME_PREFIX } from '../_support/sweep-tree.js';

// Every `mkdtemp(join(tmpdir(), …))` in the suite used to land directly in the user temp
// directory and stay there — the success paths cleaned up, the failure paths did not, and the
// per-file `jinn-test-home-*` root was never removed at all. `test/_support/isolate-home.ts`
// now redirects `$TMPDIR` into the isolated home and sweeps the whole home on teardown, so one
// removal takes every temp directory the file created with it. `test/_support/global-tmp-root.ts`
// records that home in a per-run registry and sweeps every recorded home after the workers exit,
// so a file whose tests are all skipped — which never fires an `afterAll` — leaves nothing behind
// either.
//
// Like `home-isolation.test.ts`, this file deliberately does NOT import the setup file —
// importing it would perform the redirect, and the test would then pass even with the
// `setupFiles` wiring deleted. It reads the path the setup file publishes as an environment
// variable instead, so removing the wiring turns this file red.
const managedTmp = process.env['JINN_TEST_TMPDIR'];
const isolatedHome = process.env['JINN_TEST_ISOLATED_HOME'];
const runRegistry = process.env['JINN_TEST_RUN_TMPDIR'];

describe('test tmpdir isolation', () => {
  it('is wired as a suite-wide setup file', () => {
    expect(managedTmp, 'test/_support/isolate-home.ts is not in vitest setupFiles').toBeTypeOf(
      'string',
    );
    expect(String(managedTmp).startsWith(String(isolatedHome))).toBe(true);
  });

  it('is wired as a global setup file', () => {
    // Only `global-tmp-root.ts` publishes this, and only Vitest's `globalSetup` hook runs it, so
    // an absent value means the `globalSetup` entry is gone from vitest.config.ts.
    expect(
      runRegistry,
      'test/_support/global-tmp-root.ts is not in vitest globalSetup',
    ).toBeTypeOf('string');
  });

  it('registers its isolated home with the per-run teardown', () => {
    // Nesting the home inside a per-run parent would be the obvious shape, and is not available
    // here — see `global-tmp-root.ts` on the 104-byte unix-socket path limit that the suite's
    // `tsx` subprocesses run into. The registry file is what the per-run teardown reads, so its
    // presence is the wiring a fully-skipped file depends on.
    const recorded = join(String(runRegistry), basename(String(isolatedHome)));
    expect(existsSync(recorded), `${isolatedHome} is not registered in ${runRegistry}`).toBe(true);
    expect(readFileSync(recorded, 'utf8')).toBe(isolatedHome);
  });

  it('redirects os.tmpdir() at the managed root', () => {
    expect(tmpdir()).toBe(managedTmp);
  });

  it('creates every mkdtemp directory inside the managed root', () => {
    const probe = mkdtempSync(join(tmpdir(), 'probe-'));
    try {
      expect(probe.startsWith(String(managedTmp))).toBe(true);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });

  it('registers the teardown that sweeps the managed root', () => {
    // The `afterAll` half cannot be observed from inside a test, but the `process.on('exit')`
    // backstop can. That backstop is best-effort — measured, it fires for a file that throws at
    // import time and not for a fully-skipped one — so this asserts only that it is still
    // registered. The guarantee lives in the per-run teardown asserted below.
    expect(process.listeners('exit').some((fn) => fn.name === 'jinnTestHomeSweep')).toBe(true);
  });

  it('removes every registered home on teardown', () => {
    // Vitest calls this teardown in the main process once every worker is gone, which is why it
    // catches homes no worker swept. It cannot be observed from inside a worker, so the function
    // is driven directly here: `setup()` builds a fresh registry, this registers a throwaway home
    // holding a sealed subtree the way the venue provisioner does, and the returned teardown has
    // to remove both the home and the registry.
    const previous = process.env['JINN_TEST_RUN_TMPDIR'];
    try {
      const teardown = globalTmpRootSetup();
      const registry = String(process.env['JINN_TEST_RUN_TMPDIR']);
      expect(registry).not.toBe(previous);

      // Created next to the real isolated homes, because the teardown deliberately only honours
      // recorded paths under `tmpdir()` with the expected prefix.
      const orphan = mkdtempSync(join(tmpdir(), ISOLATED_HOME_PREFIX));
      const sealed = join(orphan, 'attempt', 'input');
      mkdirSync(sealed, { recursive: true });
      writeFileSync(join(sealed, 'dispatch-context.json'), '{}', { mode: 0o400 });
      chmodSync(sealed, 0o500);
      writeFileSync(join(registry, basename(orphan)), orphan);

      teardown();

      expect(existsSync(orphan), 'the registered home survived teardown').toBe(false);
      expect(existsSync(registry), 'the registry survived teardown').toBe(false);
    } finally {
      // Sibling test files share this worker process and read the variable at setup time, so it
      // must go back exactly as it was — including the case where it was unset.
      if (previous === undefined) delete process.env['JINN_TEST_RUN_TMPDIR'];
      else process.env['JINN_TEST_RUN_TMPDIR'] = previous;
    }
  });

  // Declared last on purpose: it runs the sweep for real, which removes the isolated home the
  // earlier cases depend on.
  it('sweeps a home holding a sealed input/ directory', () => {
    // The venue provisioner seals each attempt's `input/` read-only — directories 0o500, files
    // 0o400 — so the solver process cannot rewrite its own dispatch context. A plain
    // `rmSync(recursive, force)` cannot remove that tree: `unlink` needs the write bit on the
    // parent directory and `force` only suppresses ENOENT. That is the exact failure that blocked
    // this suite's isolation, so the sweep repairs permissions before retrying.
    //
    // Re-asserted as a precondition so an unwired run fails here rather than sealing a directory
    // relative to the package root.
    expect(managedTmp, 'test/_support/isolate-home.ts is not in vitest setupFiles').toBeTypeOf(
      'string',
    );
    const home = String(isolatedHome);
    const sealed = join(String(managedTmp), 'attempt-probe', 'input');
    mkdirSync(sealed, { recursive: true });
    writeFileSync(join(sealed, 'dispatch-context.json'), '{}', { mode: 0o400 });
    chmodSync(sealed, 0o500);

    // Skipped as root, where the kernel waives the permission check and there is no bug to
    // reproduce. Everywhere else this is what makes the assertion below discriminating.
    if (process.getuid?.() !== 0) {
      expect(() => rmSync(sealed, { recursive: true, force: true })).toThrow();
    }

    // The setup file exports nothing on purpose, so the sweep is reached through the `exit`
    // listener it registers. Vitest reuses a worker process across test files, so several may be
    // registered; the most recently added one belongs to this file's setup. A wrong pick leaves
    // the home in place and fails the assertion below rather than passing quietly.
    const sweeps = process.listeners('exit').filter((fn) => fn.name === 'jinnTestHomeSweep');
    (sweeps[sweeps.length - 1] as () => void)();

    expect(existsSync(home)).toBe(false);

    // Put the home and the `tmp/` inside it back: `homedir()` and `os.tmpdir()` still point at
    // them for the rest of this process, and the `afterAll` sweep runs against the home again (a
    // no-op on an empty directory).
    mkdirSync(String(managedTmp), { recursive: true });
  });
});
