import { mkdtemp, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  DEPRECATED_BASE_SEPOLIA_STAKING_PROXY,
  detectDeprecatedTestnetSetup,
  migrateDeprecatedTestnetSetup,
} from '../../src/earning/testnet-setup-migration.js';
import { createDefaultFleetState, type FleetState } from '../../src/earning/types.js';

const NEW_STAKING_PROXY = '0x24e34E5037956a5Feca1AAAfaA30297084C228B8';
const DISTRIBUTOR = '0x40abf47B926181148000DbCC7c8DE76A3a61a66f';

function legacyState(): FleetState {
  return {
    ...createDefaultFleetState('base-sepolia'),
    master_address: '0x1111111111111111111111111111111111111111',
    services: [
      {
        index: 1,
        agent_address: '0x2222222222222222222222222222222222222222',
        safe_address: '0x3333333333333333333333333333333333333333',
        service_id: 42,
        mech_address: '0x4444444444444444444444444444444444444444',
        staking_address: DEPRECATED_BASE_SEPOLIA_STAKING_PROXY,
        step: 'complete',
        error: null,
        agent_id: '123',
        agent_uri: '',
        identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        agent_registered_tx: '0x' + 'aa'.repeat(32),
        safe_bound_to_agent: true,
      },
    ],
  };
}

async function runMigration(overrides: {
  state?: FleetState;
  stakingState?: bigint;
  sendThrows?: Error;
  waitThrows?: Error;
} = {}) {
  const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-migrate-'));
  const store = new FleetStateStore(earningDir);
  const state = overrides.state ?? legacyState();
  await store.save(state);

  const publicClient = {
    readContract: vi.fn().mockResolvedValue(overrides.stakingState ?? 1n),
  };
  const sendTransaction = vi.fn(async () => {
    if (overrides.sendThrows) throw overrides.sendThrows;
    return ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  });
  const waitForReceipt = vi.fn(async () => ({ status: 'success' as const }));
  if (overrides.waitThrows) {
    waitForReceipt.mockRejectedValue(overrides.waitThrows);
  }

  const result = await migrateDeprecatedTestnetSetup({
    stateStore: store,
    state,
    chain: 'base-sepolia',
    stakingMode: 'standard',
    currentStakingContract: NEW_STAKING_PROXY,
    distributorAddress: DISTRIBUTOR,
    publicClient: publicClient as any,
    masterWallet: { account: { address: state.master_address } } as any,
    sendTransaction: sendTransaction as any,
    waitForReceipt: waitForReceipt as any,
  });

  return { earningDir, store, result, sendTransaction, waitForReceipt };
}

describe('automatic testnet setup migration', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('archives old setup, retires it, and resets live runtime fields while preserving identity', async () => {
    const { earningDir, store, result, sendTransaction } = await runMigration();
    dirs.push(earningDir);

    expect(result.migratedCount).toBe(1);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.archivePaths).toHaveLength(1);
    await expect(stat(result.archivePaths[0]!)).resolves.toBeDefined();

    const svc = result.state.services[0]!;
    expect(svc.service_id).toBeNull();
    expect(svc.safe_address).toBeNull();
    expect(svc.mech_address).toBeNull();
    expect(svc.staking_address).toBeNull();
    expect(svc.step).toBe('awaiting_stake');
    expect(svc.error).toBeNull();
    expect(svc.agent_address).toBe('0x2222222222222222222222222222222222222222');
    expect(svc.agent_id).toBe('123');
    expect(svc.identity_registry_address).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(svc.safe_bound_to_agent).toBe(false);

    const archive = await store.loadMigrationArchive();
    expect(archive.entries).toHaveLength(1);
    const entry = archive.entries[0]!;
    expect(entry.retire_status).toBe('retired');
    expect(entry.retire_tx_hash).toMatch(/^0x/);
    expect(entry.from.service_id).toBe(42);
    expect(entry.from.safe_address).toBe('0x3333333333333333333333333333333333333333');
    expect(getAddress(entry.from.staking_address!)).toBe(getAddress(DEPRECATED_BASE_SEPOLIA_STAKING_PROXY));
    expect(entry.from.agent_id).toBe('123');
    expect(entry.state_reset_at).toBeTruthy();
  });

  it('continues to the new setup when old setup retirement fails', async () => {
    const { earningDir, store, result, sendTransaction } = await runMigration({
      sendThrows: new Error('retire rejected'),
    });
    dirs.push(earningDir);

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.state.services[0]!.step).toBe('awaiting_stake');
    expect(result.state.services[0]!.agent_id).toBe('123');

    const archive = await store.loadMigrationArchive();
    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0]!.retire_status).toBe('failed');
    expect(archive.entries[0]!.retire_error).toContain('retire rejected');
  });

  it('records the retirement tx hash when receipt waiting fails after broadcast', async () => {
    const { earningDir, store } = await runMigration({
      waitThrows: new Error('receipt timeout'),
    });
    dirs.push(earningDir);

    const archive = await store.loadMigrationArchive();
    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0]!.retire_status).toBe('failed');
    expect(archive.entries[0]!.retire_tx_hash).toBe('0x' + 'ab'.repeat(32));
    expect(archive.entries[0]!.retire_error).toContain('receipt timeout');
  });

  it('records already inactive old setups without sending a retirement transaction', async () => {
    const { earningDir, store, sendTransaction } = await runMigration({ stakingState: 0n });
    dirs.push(earningDir);

    expect(sendTransaction).not.toHaveBeenCalled();
    const archive = await store.loadMigrationArchive();
    expect(archive.entries[0]!.retire_status).toBe('already_inactive');
  });

  it('is idempotent when an archive exists and the old row is seen again', async () => {
    const original = legacyState();
    const first = await runMigration({ state: original, stakingState: 0n });
    dirs.push(first.earningDir);

    await first.store.save(original);
    const secondSend = vi.fn(async () => ('0x' + 'cd'.repeat(32)) as `0x${string}`);
    const second = await migrateDeprecatedTestnetSetup({
      stateStore: first.store,
      state: original,
      chain: 'base-sepolia',
      stakingMode: 'standard',
      currentStakingContract: NEW_STAKING_PROXY,
      distributorAddress: DISTRIBUTOR,
      publicClient: { readContract: vi.fn().mockResolvedValue(1n) } as any,
      masterWallet: { account: { address: original.master_address } } as any,
      sendTransaction: secondSend as any,
      waitForReceipt: vi.fn() as any,
    });

    expect(second.migratedCount).toBe(1);
    expect(secondSend).not.toHaveBeenCalled();
    const archive = await first.store.loadMigrationArchive();
    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0]!.retire_status).toBe('already_inactive');
  });

  it('only detects the known deprecated default setup on Base Sepolia standard mode', () => {
    const state = legacyState();
    expect(detectDeprecatedTestnetSetup({
      state,
      chain: 'base-sepolia',
      stakingMode: 'standard',
      currentStakingContract: NEW_STAKING_PROXY,
    }).services).toHaveLength(1);

    const custom = {
      ...state,
      services: [{ ...state.services[0]!, staking_address: '0x5555555555555555555555555555555555555555' }],
    };
    expect(detectDeprecatedTestnetSetup({
      state: custom,
      chain: 'base-sepolia',
      stakingMode: 'standard',
      currentStakingContract: NEW_STAKING_PROXY,
    }).services).toHaveLength(0);

    expect(detectDeprecatedTestnetSetup({
      state,
      chain: 'base',
      stakingMode: 'standard',
      currentStakingContract: NEW_STAKING_PROXY,
    }).services).toHaveLength(0);
  });
});
