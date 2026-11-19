import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { makeCommandCtx } from '@test/cli.js';
import { createFleetScaleCommand, type FleetScaleDeps } from '../../../src/cli/commands/fleet-scale.js';
import { resolveCliPassword } from '../../../src/cli/password.js';
import { createCliSignerContext } from '../../../src/cli/execution-context.js';
import { findServiceByDisplayIndex } from '../../../src/earning/fleet-display-index.js';
import { createDefaultFleetState, createDefaultServiceState, type ServiceState } from '../../../src/earning/types.js';
import { FleetStateStore } from '../../../src/earning/store.js';
import { encryptMnemonic } from '../../../src/earning/wallet.js';

// `jinn fleet scale` and `jinn fleet retire` used to read --password-fd twice: once in the verb and
// again when the signer context resolved the password. A descriptor can be read once, so the second
// read came back empty and every `--yes` run failed with "Password from --password-fd is empty."
// (#5408). These tests give each verb a real descriptor and a different JINN_PASSWORD, with the real
// resolver and the real signer context, and check the descriptor's password is the one used.

const FD_PASSWORD = 'password-from-the-descriptor';
const ENV_PASSWORD = 'a-different-password-from-env';
const MNEMONIC = 'test test test test test test test test test test test junk';

const service = (index: number): ServiceState => ({
  ...createDefaultServiceState(index, '0xA'),
  service_id: index,
  step: 'complete',
});

const raw: GatheredStatusRaw = {
  shutdownState: null,
  dbPath: '',
  activityCounts: {},
  recentActivity: [],
  lastRewardClaimTickAt: null,
  rewardClaimIntervalMs: 1,
  fleet: {
    master_address: '0xM',
    chain: 'base-sepolia',
    staking_mode: 'standard',
    updated_at: '2026-04-14T12:00:00.000Z',
    services: [service(1), service(2)],
  },
  rpc: { ok: true },
  master: { address: '0xM' },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
};

describe('fleet scale and retire read --password-fd once (#5408)', () => {
  let root: string;
  let configPath: string;
  let fd: number;
  const seen: { bootstrapPassword?: string; retired?: boolean } = {};

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'jinn-fleet-password-fd-'));
    const earningDir = join(root, 'earning');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(await encryptMnemonic(MNEMONIC, FD_PASSWORD));
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: '0x0000000000000000000000000000000000000009',
    });
    configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ network: 'testnet', earningDir, rpcUrl: 'http://127.0.0.1:1' }));
    const secretPath = join(root, 'secret');
    writeFileSync(secretPath, `${FD_PASSWORD}\n`);
    fd = openSync(secretPath, 'r');
    seen.bootstrapPassword = undefined;
    seen.retired = undefined;
  });

  afterEach(() => {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  });

  function deps(): FleetScaleDeps {
    return {
      loadConfig: () => ({ earningDir: join(root, 'earning') } as any),
      getConfigPathFromArgs: () => undefined,
      gatherIntrospectionRaw: async () => raw,
      resolveCliPassword,
      signerContextFactory: createCliSignerContext,
      bootstrapperFactory: () => ({
        bootstrap: async (password: string) => {
          seen.bootstrapPassword = password;
          return { ok: true, message: 'ok', fleet_state: { master_address: '0xM', services: [] } };
        },
      }) as any,
      retireFleetServiceOnChain: async () => {
        seen.retired = true;
        return { ok: true, message: 'retired', txHash: '0xabc' } as any;
      },
      findServiceByDisplayIndex,
      isRecoverableTransactionError: () => false,
      checkDaemonGuard: () => ({ blocked: false, pid: null, pidfilePath: '', reason: 'not-running' as const }),
    };
  }

  it('scale --to 3 --yes uses the descriptor password for the signer context and the bootstrap', async () => {
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['scale', '--to', '3', '--yes', '--config', configPath, '--password-fd', String(fd)],
      env: { JINN_PASSWORD: ENV_PASSWORD },
    });
    await createFleetScaleCommand(deps()).run(ctx);
    expect(writes.join('')).not.toContain('--password-fd is empty');
    expect(writes.join('')).not.toContain('Failed to decrypt');
    expect(exits).toEqual([]);
    expect(seen.bootstrapPassword).toBe(FD_PASSWORD);
  });

  it('retire 1 --yes uses the descriptor password for the signer context', async () => {
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['retire', '1', '--yes', '--config', configPath, '--password-fd', String(fd)],
      env: { JINN_PASSWORD: ENV_PASSWORD },
    });
    await createFleetScaleCommand(deps()).run(ctx);
    expect(writes.join('')).not.toContain('--password-fd is empty');
    expect(writes.join('')).not.toContain('Failed to decrypt');
    expect(exits).toEqual([]);
    expect(seen.retired).toBe(true);
  });
});
