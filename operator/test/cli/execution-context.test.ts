import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCliReadOnlySignerContext,
  createCliSignerContext,
  pickPrimaryMechService,
} from '../../src/cli/execution-context.js';
import { createDefaultFleetState, type ServiceState } from '../../src/earning/types.js';
import { FleetStateStore, STATE_FILE } from '../../src/earning/store.js';
import { encryptMnemonic } from '../../src/earning/wallet.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

function svc(partial: Partial<ServiceState> & Pick<ServiceState, 'index' | 'step'>): ServiceState {
  return {
    agent_address: '0x0000000000000000000000000000000000000001',
    safe_address: null,
    service_id: null,
    mech_address: null,
    staking_address: null,
    error: null,
    ...partial,
  };
}

describe('pickPrimaryMechService', () => {
  it('returns the first complete service with safe and mech', () => {
    const a = svc({
      index: 1,
      step: 'complete',
      safe_address: '0x1111111111111111111111111111111111111111',
      mech_address: '0x2222222222222222222222222222222222222222',
    });
    const b = svc({
      index: 2,
      step: 'complete',
      safe_address: '0x3333333333333333333333333333333333333333',
      mech_address: null,
    });
    expect(pickPrimaryMechService([b, a])).toEqual(a);
  });

  it('returns undefined when no eligible service', () => {
    expect(
      pickPrimaryMechService([
        svc({ index: 1, step: 'complete', safe_address: '0x1111111111111111111111111111111111111111' }),
      ]),
    ).toBeUndefined();
  });
});

describe('createCliReadOnlySignerContext', () => {
  it('does not create, rename, or rewrite fleet files for missing or invalid state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-readonly-signer-'));
    const password = 'test-password';
    const makeConfig = (earningDir: string, name: string) => {
      const path = join(root, `${name}.json`);
      writeFileSync(path, JSON.stringify({
        network: 'testnet',
        earningDir,
        rpcUrl: 'http://127.0.0.1:1',
      }));
      return path;
    };

    const missingKeystoreDir = join(root, 'missing-keystore');
    const missingKeystore = await createCliReadOnlySignerContext({
      argv: ['--config', makeConfig(missingKeystoreDir, 'missing-keystore')],
      env: { JINN_PASSWORD: password },
    });
    expect(missingKeystore.ok).toBe(false);
    expect(existsSync(missingKeystoreDir)).toBe(false);

    const earningDir = join(root, 'earning');
    const fleetStore = new FleetStateStore(earningDir);
    await fleetStore.saveMnemonicKeystore(await encryptMnemonic(
      'test test test test test test test test test test test junk',
      password,
    ));
    const missingStateBefore = readdirSync(earningDir);
    const missingState = await createCliReadOnlySignerContext({
      argv: ['--config', makeConfig(earningDir, 'missing-state')],
      env: { JINN_PASSWORD: password },
    });
    expect(missingState.ok).toBe(false);
    expect(readdirSync(earningDir)).toEqual(missingStateBefore);
    expect(existsSync(join(earningDir, STATE_FILE))).toBe(false);

    const invalidStatePath = join(earningDir, STATE_FILE);
    writeFileSync(invalidStatePath, '{"invalid":true}\n');
    const invalidBefore = readFileSync(invalidStatePath, 'utf8');
    const filesBefore = readdirSync(earningDir);
    const invalidState = await createCliReadOnlySignerContext({
      argv: ['--config', makeConfig(earningDir, 'invalid-state')],
      env: { JINN_PASSWORD: password },
    });
    expect(invalidState.ok).toBe(false);
    expect(readFileSync(invalidStatePath, 'utf8')).toBe(invalidBefore);
    expect(readdirSync(earningDir)).toEqual(filesBefore);
  });
});

// D0a review (round 1), critical finding: `buildCliSignerContext` (shared by
// `createCliSignerContext`, `createCliReadOnlySignerContext`, and
// `createCliExecutionContext`) must refuse when a live `jinn run` daemon is
// detected against the target earning directory -- every context it returns
// hands the caller live signer key material (`masterWallet` / `mnemonic`)
// that downstream code (e.g. `jinn claim-rewards` via `runRewardClaimOnce`)
// signs Safe / EOA writes with, with no cross-process lock against the
// daemon signing from the same keys. Previously the guard was wired only
// into `createCliExecutionContext`, leaving `createCliSignerContext` (and
// `jinn claim-rewards`, which uses it directly) unguarded.
describe('buildCliSignerContext daemon guard (D0a round 1)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jinn-signer-ctx-daemon-guard-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    __resetExecSyncForTesting();
  });

  function makeConfig(earningDir: string): string {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({
      network: 'testnet',
      earningDir,
      rpcUrl: 'http://127.0.0.1:1',
    }));
    return path;
  }

  it('createCliSignerContext refuses when a live jinn daemon is detected', async () => {
    const earningDir = join(root, 'earning');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(await encryptMnemonic(
      'test test test test test test test test test test test junk',
      'test-password',
    ));
    writeFileSync(join(earningDir, 'daemon.pid'), '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);

    try {
      const result = await createCliSignerContext({
        argv: ['--config', makeConfig(earningDir)],
        env: { JINN_PASSWORD: 'test-password' },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.envelope.code).toBe('invalid_invocation');
        expect(result.envelope.message).toContain('987654');
      }
    } finally {
      killSpy.mockRestore();
    }
  });

  // D0a round-2 correction: round-1 put the guard on `buildCliSignerContext` itself, which also
  // reached `createCliReadOnlySignerContext` -- but that function's one production caller
  // (`jinn tasks submit --dry-run`'s machine-request preflight, tasks.ts) never signs or
  // broadcasts anything; it only reads fleet state to preview the plan. Guarding it produced a
  // pure false positive in the ordinary operating configuration (operator's daemon running,
  // operator previews a submission) whose only escape was
  // `JINN_ALLOW_CLI_BROADCAST_WITH_DAEMON=1` -- an opt-out that asks the operator to affirm
  // something meaningless for a preview and trains them to leave it set, silently disarming the
  // guard for the real `--yes` submit later. `createCliReadOnlySignerContext` is unguarded; the
  // signing paths (`createCliSignerContext` / `createCliExecutionContext`) remain guarded above.
  it('createCliReadOnlySignerContext does NOT block a dry-run preview when a live jinn daemon is detected', async () => {
    const earningDir = join(root, 'earning-ro');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(await encryptMnemonic(
      'test test test test test test test test test test test junk',
      'test-password',
    ));
    // `makeConfig` below sets `network: 'testnet'`, i.e. networkChain 'base-sepolia' -- the
    // read-only fleet-load path (`tryLoadExisting`) requires a persisted state file whose chain
    // matches, or it treats the state as absent/mismatched and returns `ok: false` regardless of
    // the daemon guard. Persist a valid default state so this test isolates the guard behavior.
    await store.save(createDefaultFleetState('base-sepolia'));
    writeFileSync(join(earningDir, 'daemon.pid'), '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);

    try {
      const result = await createCliReadOnlySignerContext({
        argv: ['--config', makeConfig(earningDir)],
        env: { JINN_PASSWORD: 'test-password' },
      });
      expect(result.ok).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does not block when no daemon is running', async () => {
    const earningDir = join(root, 'earning-clean');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(await encryptMnemonic(
      'test test test test test test test test test test test junk',
      'test-password',
    ));
    // No daemon.pid file at all -- proves the guard is not blocking unconditionally.
    const result = await createCliSignerContext({
      argv: ['--config', makeConfig(earningDir)],
      env: { JINN_PASSWORD: 'test-password' },
    });
    expect(result.ok).toBe(true);
  });
});
