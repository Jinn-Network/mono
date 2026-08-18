import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG_PATH, loadConfig } from '../../src/config.js';
import { ISOLATED_HOME_PREFIX } from '../_support/sweep-tree.js';

// The operator's real `~/.jinn-client/config.json` is a production artefact: it holds their
// joined SolverNets, RPC chain and staking posture, and since the stage-1 shape-v2 migration
// `loadConfig()` rewrites it in place. No test may reach it.
//
// This file is the standing proof of that property. It deliberately does NOT import
// `test/_support/isolate-home.ts` — importing it would perform the isolation, and the test would
// then pass even with the `setupFiles` wiring deleted. It reads the two paths the setup file
// publishes as environment variables instead, so removing the wiring turns this file red.
const isolatedHome = process.env['JINN_TEST_ISOLATED_HOME'];
const realHome = process.env['JINN_TEST_REAL_HOME'];

describe('test home isolation', () => {
  it('is wired as a suite-wide setup file', () => {
    expect(isolatedHome, 'test/_support/isolate-home.ts is not in vitest setupFiles').toBeTypeOf(
      'string',
    );
    expect(realHome).toBeTypeOf('string');
    // Read from the shared constant rather than spelled out again: the prefix is what the per-run
    // guard admits, so a bare literal here would go green against a home the guard rejects.
    expect(isolatedHome).toContain(ISOLATED_HOME_PREFIX);
  });

  it('redirects the home directory away from the real one', () => {
    expect(homedir()).toBe(isolatedHome);
    expect(homedir()).not.toBe(realHome);
  });

  it('resolves config.ts’s module-level default paths inside the isolated home', () => {
    // `DEFAULT_CONFIG_PATH` is captured at module load. Asserting on it — rather than on a
    // freshly computed path — is what proves the setup file wins the ordering race against the
    // first import of `src/config.ts`.
    expect(DEFAULT_CONFIG_PATH.startsWith(String(isolatedHome))).toBe(true);
    expect(DEFAULT_CONFIG_PATH.startsWith(join(String(realHome), '.jinn-operator'))).toBe(false);
    expect(DEFAULT_CONFIG_PATH.startsWith(join(String(realHome), '.jinn-client'))).toBe(false);
  });

  it('resolves the loaded config’s derived paths inside the isolated home', () => {
    const config = loadConfig();
    expect(config.earningDir.startsWith(String(isolatedHome))).toBe(true);
    expect(config.dbPath.startsWith(String(isolatedHome))).toBe(true);
  });

  it('leaves no operator config behind in the isolated home after a default load', () => {
    loadConfig();
    // A default load against an empty home must not fabricate a config file — the shape-v2
    // migration only ever rewrites a file that already exists.
    let entries: string[] = [];
    try {
      entries = readdirSync(join(String(isolatedHome), '.jinn-operator'));
    } catch {
      entries = [];
    }
    expect(entries.filter((name) => name.startsWith('config.json'))).toEqual([]);
  });
});
