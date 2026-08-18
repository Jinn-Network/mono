import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Every `mkdtemp(join(tmpdir(), …))` in the suite used to land directly in the user temp
// directory and stay there — the success paths cleaned up, the failure paths did not, and the
// per-file `jinn-test-home-*` root was never removed at all. `test/_support/isolate-home.ts`
// now redirects `$TMPDIR` into the isolated home and sweeps the whole home on teardown, so one
// removal takes every temp directory the file created with it.
//
// Like `home-isolation.test.ts`, this file deliberately does NOT import the setup file —
// importing it would perform the redirect, and the test would then pass even with the
// `setupFiles` wiring deleted. It reads the path the setup file publishes as an environment
// variable instead, so removing the wiring turns this file red.
const managedTmp = process.env['JINN_TEST_TMPDIR'];
const isolatedHome = process.env['JINN_TEST_ISOLATED_HOME'];

describe('test tmpdir isolation', () => {
  it('is wired as a suite-wide setup file', () => {
    expect(managedTmp, 'test/_support/isolate-home.ts is not in vitest setupFiles').toBeTypeOf(
      'string',
    );
    expect(String(managedTmp).startsWith(String(isolatedHome))).toBe(true);
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
    // backstop can. Asserting on the listener is what proves the teardown survives a test file
    // that throws at import time — the case `afterAll` cannot cover.
    expect(process.listeners('exit').some((fn) => fn.name === 'jinnTestHomeSweep')).toBe(true);
  });
});
