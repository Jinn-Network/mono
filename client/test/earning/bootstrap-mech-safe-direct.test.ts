import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import * as safeAdapter from '../../src/earning/safe-adapter.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  deriveAgentAddress,
  deriveMasterAddress,
  generateMnemonic,
} from '../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../src/earning/types.js';

vi.mock('../../src/earning/safe-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/earning/safe-adapter.js')>();
  return {
    ...actual,
    initDeployedSafe: vi.fn(),
    executeSafeTxDirect: vi.fn(),
  };
});

describe('Fleet bootstrap Mech deployment Safe execution', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('deploys the Mech through direct Safe execution instead of Safe SDK deployed-safe detection', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-mech-safe-direct-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const masterAddress = deriveMasterAddress(mnemonic);
    const agentAddress = deriveAgentAddress(mnemonic, 1);
    const safeAddress = '0x2222222222222222222222222222222222222222';
    const mechAddress = '0x3333333333333333333333333333333333333333';
    const txHash = `0x${'aa'.repeat(32)}` as `0x${string}`;

    const store = new FleetStateStore(earningDir);
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: masterAddress,
      services: [
        {
          index: 1,
          agent_address: agentAddress,
          safe_address: safeAddress,
          service_id: 42,
          mech_address: null,
          staking_address: '0x24e34E5037956a5Feca1AAAfaA30297084C228B8',
          step: 'staked',
          error: null,
          agent_id: null,
          agent_uri: null,
          identity_registry_address: null,
          agent_registered_tx: null,
          safe_bound_to_agent: false,
        },
      ],
    });

    const directSafeExec = vi.mocked(safeAdapter.executeSafeTxDirect);
    directSafeExec.mockResolvedValue({ hash: txHash });
    vi.mocked(safeAdapter.initDeployedSafe).mockRejectedValue(
      new Error('Safe SDK should not be used for Mech deployment'),
    );

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance')
      .mockResolvedValue(10_000_000_000_000_000n);
    vi.spyOn((bootstrapper as any).publicClient, 'waitForTransactionReceipt')
      .mockResolvedValue({
        status: 'success',
        logs: [
          {
            topics: [
              '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6',
              `0x${'0'.repeat(24)}${mechAddress.slice(2).toLowerCase()}`,
            ],
          },
        ],
      } as any);

    const state = await store.load('base-sepolia');
    await (bootstrapper as any).stepDeployMech(state, mnemonic, 1);

    expect(safeAdapter.initDeployedSafe).not.toHaveBeenCalled();
    expect(directSafeExec).toHaveBeenCalledOnce();
    expect(directSafeExec).toHaveBeenCalledWith(expect.objectContaining({
      rpcUrl: 'http://127.0.0.1:8545',
      safeAddress,
      to: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      data: expect.stringMatching(/^0x/),
    }));

    const updated = await store.load('base-sepolia');
    const service = updated.services[0];
    expect(getAddress(service.mech_address!)).toBe(getAddress(mechAddress));
    expect(service.step).toBe('mech_deployed');
  });
});
