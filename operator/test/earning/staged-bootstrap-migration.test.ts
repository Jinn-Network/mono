import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetStateStore } from '../../src/earning/store.js';

describe('FleetStateStore — legacy state-file migration (nghf)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('promotes services[0].agent_id to fleet_agent_id when fleet_* is missing', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const legacy = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: '0xAAAA000000000000000000000000000000000001',
          safe_address: '0xBBBB000000000000000000000000000000000001',
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
          agent_id: '777',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
      updated_at: new Date().toISOString(),
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(legacy, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    expect(loaded.fleet_agent_id).toBe('777');
    expect(loaded.fleet_safe_address).toBe('0xBBBB000000000000000000000000000000000001');
    expect(loaded.fleet_identity_registry).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(loaded.fleet_stage).toBe('stage1_and_2');

    // Non-destructive: original per-service identity is preserved.
    expect(loaded.services[0].agent_id).toBe('777');
    expect(loaded.services[0].safe_address).toBe('0xBBBB000000000000000000000000000000000001');
    expect(loaded.services[0].identity_registry_address).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(loaded.services[0].safe_bound_to_agent).toBe(true);
  });

  it('promotes to fleet_stage="stage1" when services[0] has agent_id but no service_id (mid-walk)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const legacy = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: '0xAAAA000000000000000000000000000000000001',
          safe_address: '0xBBBB000000000000000000000000000000000001',
          service_id: null,
          mech_address: null,
          staking_address: null,
          step: 'awaiting_stake',
          error: null,
          agent_id: '99',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'bb'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
      updated_at: new Date().toISOString(),
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(legacy, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    expect(loaded.fleet_agent_id).toBe('99');
    expect(loaded.fleet_safe_address).toBe('0xBBBB000000000000000000000000000000000001');
    expect(loaded.fleet_stage).toBe('stage1');
  });

  it('leaves fleet_stage="none" when no services and no fleet identity', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const legacy = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [],
      updated_at: new Date().toISOString(),
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(legacy, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    expect(loaded.fleet_agent_id).toBeNull();
    expect(loaded.fleet_safe_address).toBeNull();
    expect(loaded.fleet_stage).toBe('none');
  });

  it('leaves fleet_stage="stage1_and_2" when services[0] is complete but legacy lacks agent_id (pre-j07)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const legacy = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: '0xAAAA000000000000000000000000000000000001',
          safe_address: '0xBBBB000000000000000000000000000000000001',
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
        },
      ],
      updated_at: new Date().toISOString(),
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(legacy, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    // No agent_id to promote — fleet identity stays null but stage reflects
    // operator completion so ensureStage1And2 does not re-deploy a Safe.
    expect(loaded.fleet_agent_id).toBeNull();
    expect(loaded.fleet_stage).toBe('stage1_and_2');
  });

  it('preserves existing fleet_* fields when both fleet and service identity coexist', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const recent = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: '0xAAAA000000000000000000000000000000000001',
          safe_address: '0xBBBB000000000000000000000000000000000001',
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
          agent_id: '777',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
      updated_at: new Date().toISOString(),
      fleet_agent_id: '999',
      fleet_safe_address: '0xFFFF000000000000000000000000000000000001',
      fleet_identity_registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      fleet_stage: 'stage1_and_2',
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(recent, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    expect(loaded.fleet_agent_id).toBe('999');
    expect(loaded.fleet_safe_address).toBe('0xFFFF000000000000000000000000000000000001');
    expect(loaded.fleet_stage).toBe('stage1_and_2');
  });
});
