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
import { basename, dirname, join, sep } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// Safe to import: unlike the setup file, this module performs nothing at import time — the root is
// only created when `setup()` is called. The wiring assertions below still read the environment,
// so deleting the `globalSetup` entry turns this file red.
import globalTmpRootSetup from '../_support/global-tmp-root.js';
import {
  ISOLATED_HOME_PREFIX,
  KEEP_ARTIFACT_FLAGS,
  MAX_MANAGED_ROOT_BYTES,
  assertSocketSafeRoot,
  isSweepableRecord,
  sweepManagedTree,
} from '../_support/sweep-tree.js';

// Every `mkdtemp(join(tmpdir(), …))` in the suite used to land directly in the user temp
// directory and stay there — the success paths cleaned up, the failure paths did not, and the
// per-file `jinn-home-*` root was never removed at all. `test/_support/isolate-home.ts`
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
const hostTmpdir = process.env['JINN_TEST_HOST_TMPDIR'];

/**
 * Drives `setup()` the way Vitest does — repeatedly, where the case calls for it — and restores
 * what the run left behind. Every teardown handed out is invoked on the way out even when an
 * assertion threw, so the interrupt handlers `setup()` installs cannot leak into the rest of this
 * worker; a teardown that already ran is a no-op. `JINN_TEST_RUN_TMPDIR` and
 * `JINN_TEST_HOST_TMPDIR` are read at setup time by sibling test files sharing this worker, so
 * both go back exactly as they were — including the case where they were unset.
 */
function withGlobalSetup(run: (setup: () => () => void) => void): void {
  const restore = (['JINN_TEST_RUN_TMPDIR', 'JINN_TEST_HOST_TMPDIR'] as const).map((name) => ({
    name,
    value: process.env[name],
  }));
  const teardowns: Array<() => void> = [];
  try {
    run(() => {
      const teardown = globalTmpRootSetup();
      teardowns.push(teardown);
      return teardown;
    });
  } finally {
    for (const teardown of teardowns) teardown();
    for (const { name, value } of restore) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('test tmpdir isolation', () => {
  it('is wired as a suite-wide setup file', () => {
    expect(managedTmp, 'test/_support/isolate-home.ts is not in vitest setupFiles').toBeTypeOf(
      'string',
    );
    expect(String(managedTmp).startsWith(String(isolatedHome))).toBe(true);
  });

  it('is wired as a global setup file', () => {
    // Only `global-tmp-root.ts` publishes these, and only Vitest's `globalSetup` hook runs it, so
    // an absent value means the `globalSetup` entry is gone from vitest.config.ts.
    expect(
      runRegistry,
      'test/_support/global-tmp-root.ts is not in vitest globalSetup',
    ).toBeTypeOf('string');
    expect(hostTmpdir).toBeTypeOf('string');

    // The isolated home is created directly inside the published host temp directory rather than
    // inside whatever `tmpdir()` reports in the worker. That is what makes the base a worker
    // records against and the base the per-run guard checks against the same string, and what lets
    // a REUSED worker create its next home somewhere that still exists.
    expect(dirname(String(isolatedHome))).toBe(hostTmpdir);
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
    withGlobalSetup((setup) => {
      const previous = process.env['JINN_TEST_RUN_TMPDIR'];
      const teardown = setup();
      const registry = String(process.env['JINN_TEST_RUN_TMPDIR']);
      const base = String(process.env['JINN_TEST_HOST_TMPDIR']);
      expect(registry).not.toBe(previous);

      // Created next to the real isolated homes, because the teardown deliberately only honours
      // recorded paths under the published host temp directory with the expected prefix.
      const orphan = mkdtempSync(join(base, ISOLATED_HOME_PREFIX));
      const sealed = join(orphan, 'attempt', 'input');
      mkdirSync(sealed, { recursive: true });
      writeFileSync(join(sealed, 'dispatch-context.json'), '{}', { mode: 0o400 });
      chmodSync(sealed, 0o500);
      writeFileSync(join(registry, basename(orphan)), orphan);

      teardown();

      expect(existsSync(orphan), 'the registered home survived teardown').toBe(false);
      expect(existsSync(registry), 'the registry survived teardown').toBe(false);
    });
  });

  it('keeps one registry when the global setup runs twice in one process', () => {
    // `vitest.config.ts` declares `projects: [{ extends: true }]`, so Vitest invokes the
    // `globalSetup` entry twice per run — once for the root config, once for the project — in the
    // same process. A second registry there is not a harmless duplicate: every worker records into
    // whichever one `JINN_TEST_RUN_TMPDIR` names last, while the FIRST invocation's interrupt
    // handlers run first and call `process.exit`, which ends the emit loop before the handlers
    // holding the populated registry are ever reached. Measured before this guard existed, a
    // SIGTERM mid-run therefore swept nothing at all.
    withGlobalSetup((setup) => {
      const signalListeners = process.listeners('SIGTERM').length;
      const first = setup();
      const registry = String(process.env['JINN_TEST_RUN_TMPDIR']);
      const base = String(process.env['JINN_TEST_HOST_TMPDIR']);
      const second = setup();

      expect(
        process.env['JINN_TEST_RUN_TMPDIR'],
        'the second setup orphaned the first registry',
      ).toBe(registry);
      expect(second, 'the second setup returned a teardown of its own').toBe(first);
      expect(
        process.listeners('SIGTERM').length,
        'the second setup installed a second interrupt handler',
      ).toBe(signalListeners + 1);

      // Recorded after the second setup, which is the case that leaked: it has to be swept by the
      // teardown either invocation hands back.
      const orphan = mkdtempSync(join(base, ISOLATED_HOME_PREFIX));
      writeFileSync(join(registry, basename(orphan)), orphan);

      second();

      expect(existsSync(orphan), 'the registered home survived teardown').toBe(false);
      expect(existsSync(registry), 'the registry survived teardown').toBe(false);
      expect(process.listeners('SIGTERM').length).toBe(signalListeners);
    });
  });

  it('admits only records contained in the temp directory', () => {
    // The records drive `rmSync(recursive)`, so the guard has to be a containment test rather than
    // a string-prefix test: `startsWith` does not normalise `..` away, and the escape below is an
    // unbounded recursive removal of whatever it lands on.
    const base = join('/base', 'tmp');
    const escape = `${base}${sep}${ISOLATED_HOME_PREFIX}x${sep}..${sep}..${sep}..${sep}victim`;

    expect(isSweepableRecord(join(base, `${ISOLATED_HOME_PREFIX}x`), base)).toBe(true);
    expect(isSweepableRecord(join(base, `${ISOLATED_HOME_PREFIX}x`, 'attempt'), base)).toBe(true);
    expect(escape.startsWith(join(base, ISOLATED_HOME_PREFIX)), 'not the escape under test').toBe(
      true,
    );
    expect(isSweepableRecord(escape, base)).toBe(false);
    expect(isSweepableRecord(join(base, 'unmanaged'), base)).toBe(false);
    expect(isSweepableRecord(base, base)).toBe(false);
  });

  it('leaves the directory a poisoned record points at in place', () => {
    // The same escape, driven through the teardown that consumes the registry, so the guard cannot
    // be correct while going unused. The decoy component never has to exist: the record is a
    // string, and a prefix test admits it on the strength of that string alone.
    withGlobalSetup((setup) => {
      const teardown = setup();
      const registry = String(process.env['JINN_TEST_RUN_TMPDIR']);
      const base = String(process.env['JINN_TEST_HOST_TMPDIR']);
      const victim = mkdtempSync(join(base, 'jinn-test-victim-'));
      // The pivot has to be a real managed home: `rmSync` on a path whose intermediate component
      // is missing raises ENOENT, which `force` swallows, so a synthetic decoy would make the
      // escape look harmless. A real run always has one. Deliberately not recorded, so nothing
      // sweeps it but the `finally` below.
      const decoy = mkdtempSync(join(base, ISOLATED_HOME_PREFIX));
      try {
        writeFileSync(join(victim, 'evidence'), 'must survive the sweep');
        writeFileSync(join(registry, 'poisoned'), `${decoy}${sep}..${sep}${basename(victim)}`);

        teardown();

        expect(
          existsSync(victim),
          'a record escaping the managed prefix drove a recursive removal',
        ).toBe(true);
      } finally {
        rmSync(victim, { recursive: true, force: true });
        rmSync(decoy, { recursive: true, force: true });
      }
    });
  });

  it('keeps the managed trees under a keep-artifact flag', () => {
    // Three suites in `packages/benchmark-product/core` retain their workspace behind one of these
    // flags, and this seam owns the parent of every one of those workspaces. An unconditional
    // sweep deletes the retained artifact and turns the flag into a no-op — so both halves go
    // through `sweepManagedTree`, and it stands down whenever a flag is set.
    for (const flag of KEEP_ARTIFACT_FLAGS) {
      const previous = process.env[flag];
      const kept = mkdtempSync(join(tmpdir(), ISOLATED_HOME_PREFIX));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        process.env[flag] = '1';
        sweepManagedTree(kept, 'isolated home');
        expect(existsSync(kept), `${flag} did not keep ${kept}`).toBe(true);

        // Printed, because a retained artifact nobody can find is not retained.
        const printed = warn.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(printed).toContain(kept);
        expect(printed).toContain(flag);

        delete process.env[flag];
        sweepManagedTree(kept, 'isolated home');
        expect(existsSync(kept), 'the tree survived a sweep with no keep flag set').toBe(false);
      } finally {
        warn.mockRestore();
        if (previous === undefined) delete process.env[flag];
        else process.env[flag] = previous;
        rmSync(kept, { recursive: true, force: true });
      }
    }
  });

  it('refuses a managed root that leaves a spawned child no room to bind', () => {
    // Redirecting `$TMPDIR` into a per-file root spends part of the 104-byte unix-socket path
    // budget a `spawn`ed child needs for `$TMPDIR/<tool>/<pid>.sock`. Overspending it surfaced as
    // an EEXIST inside an unrelated two-process test, naming neither this seam nor `$TMPDIR`.
    const base = '/tmp';
    expect(() =>
      assertSocketSafeRoot(join(base, `${ISOLATED_HOME_PREFIX}abc123`, 'tmp'), base),
    ).not.toThrow();
    expect(() => assertSocketSafeRoot(join(base, 'x'.repeat(MAX_MANAGED_ROOT_BYTES)), base)).toThrow(
      /unix-socket path limit/,
    );
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
