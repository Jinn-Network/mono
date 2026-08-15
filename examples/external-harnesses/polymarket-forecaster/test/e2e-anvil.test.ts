/**
 * End-to-end test: the forecaster impl can be dispatched against a
 * synthetic prediction.v0 Task with an Anvil fork of Base reachable
 * (so the `network: 'base-mainnet'` env value is real). The test
 * skips when `anvil` is not on PATH.
 *
 * Note: this test does NOT exercise the daemon's loader — that lives
 * in operator/test/harnesses/external-impls/loader.test.ts. This test
 * exercises the impl in isolation; an integration test that loads
 * this package via the daemon's loader is a follow-up plan.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { execSync } from 'node:child_process';
import createHarness from '../src/index.js';
import type {
  ExternalHarnessEnv,
  HarnessContext,
} from '@jinn-network/sdk';

const ANVIL_PORT = 8765;

function anvilOnPath(): boolean {
  try {
    execSync('command -v anvil', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ANVIL = anvilOnPath();
const describeMaybe = ANVIL ? describe : describe.skip;

describeMaybe('polymarket-forecaster e2e (Anvil fork)', () => {
  let anvil: ChildProcess | null = null;

  beforeAll(async () => {
    anvil = spawn(
      'anvil',
      ['--fork-url', 'https://mainnet.base.org', '--port', String(ANVIL_PORT)],
      { stdio: 'pipe' },
    );
    await wait(2000);
  }, 30_000);

  afterAll(() => {
    anvil?.kill('SIGTERM');
  });

  it('runs the impl against a synthetic Task with anvil reachable', async () => {
    const env: ExternalHarnessEnv = {
      implName: '@jinn-examples/polymarket-forecaster',
      implVersion: '0.1.0',
      network: 'base-mainnet',
      implStateDir: '/tmp/polymarket-e2e',
      secrets: Object.freeze({}),
      log: () => {},
      stub: false,
    };
    const impl = createHarness(env);
    const ctx: HarnessContext = {
      task: {
        id: 'e2e-1',
        description: 'forecast market',
        solverType: 'prediction.v0',
        spec: { marketId: 'mk-trump-2028' },
      },
      taskCid: undefined,
      implStateDir: '/tmp/polymarket-e2e',
      workingDir: '/tmp/polymarket-e2e-work',
      log: () => {},
      abort: new AbortController().signal,
      msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => ({}) },
    };
    const out = await impl.run(ctx);
    expect(out.venueRef.name).toBe('polymarket');
    expect(typeof out.gating.probability).toBe('number');
  });
});
