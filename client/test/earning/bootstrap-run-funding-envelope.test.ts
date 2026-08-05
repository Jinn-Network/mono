/**
 * Issue #2407 R5 — `isPendingMasterFundingHalt` (earning/bootstrap-halt-classification.ts)
 * keys off `envelope.details.role === 'master'`, which bootstrap-run.ts's own
 * comment labels a "legacy alias." A hand-built envelope test can't catch a
 * future prune of that field — it would silently restore the absorbing
 * state (B2) with no failing test anywhere. This test exercises the REAL
 * `runFleetBootstrap` funding-timeout code path (mocking only
 * `FleetBootstrapper` — the on-chain-touching dependency — not
 * `failBootstrap`/the envelope construction itself) and asserts the
 * resulting `SetupBootstrapHalted`'s envelope actually carries
 * `role: 'master'`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JinnConfig } from '../../src/config.js';

vi.mock('../../src/earning/bootstrap.js', () => {
  class FakeFleetBootstrapper {
    async ensureStage1And2(): Promise<unknown> {
      // A small real delay so `Date.now() - fundingStartedAt` reliably
      // exceeds the tiny JINN_FUNDING_TIMEOUT_MS below on the first
      // iteration, without needing bootstrap-run.ts's hardcoded 15s
      // between-poll sleep to elapse.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: false,
        funding: {
          master_address: '0xMaster00000000000000000000000000000001',
          eth_required: '20000000000000000',
          eth_balance: '0',
        },
        fleet_state: { master_address: '0xMaster00000000000000000000000000000001', services: [] },
        message: 'Your master wallet needs more ETH',
      };
    }
  }
  return { FleetBootstrapper: FakeFleetBootstrapper };
});

describe('runFleetBootstrap funding-timeout envelope (#2407 R5)', () => {
  let earningDir: string;
  let previousNoUi: string | undefined;
  let previousNoDaemon: string | undefined;
  let previousTimeout: string | undefined;

  beforeEach(() => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-funding-envelope-'));
    previousNoUi = process.env['JINN_NO_UI'];
    previousNoDaemon = process.env['JINN_NO_DAEMON'];
    previousTimeout = process.env['JINN_FUNDING_TIMEOUT_MS'];
    // keepSetupUiOnBootstrapError (setup/halt-mode.ts) must return true here
    // so failBootstrap throws SetupBootstrapHalted rather than
    // emitEnvelope-exiting the test process.
    delete process.env['JINN_NO_UI'];
    delete process.env['JINN_NO_DAEMON'];
    process.env['JINN_FUNDING_TIMEOUT_MS'] = '10';
  });

  afterEach(() => {
    if (previousNoUi === undefined) delete process.env['JINN_NO_UI']; else process.env['JINN_NO_UI'] = previousNoUi;
    if (previousNoDaemon === undefined) delete process.env['JINN_NO_DAEMON']; else process.env['JINN_NO_DAEMON'] = previousNoDaemon;
    if (previousTimeout === undefined) delete process.env['JINN_FUNDING_TIMEOUT_MS']; else process.env['JINN_FUNDING_TIMEOUT_MS'] = previousTimeout;
    vi.restoreAllMocks();
  });

  it('the emitted funding_required envelope carries role: "master" (the field B2 relies on)', async () => {
    const { runFleetBootstrap, SetupBootstrapHalted } = await import('../../src/earning/bootstrap-run.js');

    const config = {
      earningDir,
      rpcUrl: 'http://127.0.0.1:1',
      stakingMode: 'standard',
      targetServices: 1,
      debug: false,
      pollIntervalMs: 5000,
      runLegacyMigrations: false,
    } as unknown as JinnConfig;

    let caught: unknown;
    try {
      await runFleetBootstrap({
        config,
        password: 'test-password',
        network: 'base-sepolia',
        emitProgress: () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SetupBootstrapHalted);
    const envelope = (caught as InstanceType<typeof SetupBootstrapHalted>).envelope;
    expect(envelope.code).toBe('funding_required');
    expect(envelope.details?.['role']).toBe('master');
  });
});
