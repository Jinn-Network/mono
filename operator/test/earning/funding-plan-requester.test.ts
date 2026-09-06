/**
 * B0a (#2446) — `planFleetFunding` must answer the question the caller's
 * persona is actually asking. Reporting the operator's 0.02 ETH bootstrap
 * target to a requester who needs creator-Safe deployment gas is the §4.2
 * defect this issue exists to close.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planFleetFunding } from '../../src/earning/funding-plan.js';
import { requesterMinMasterEth } from '../../src/earning/requester-init.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { encryptMnemonic, generateMnemonic, deriveMasterAddress } from '../../src/earning/wallet.js';
import type { FleetState } from '../../src/earning/types.js';

function fakeChainConfig(): any {
  return {
    chainId: 84532,
    rpcUrl: 'http://127.0.0.1:8545',
    minEoaGasEth: 5_000_000_000_000_000n,
    minSafeEth: 2_000_000_000_000_000n,
  };
}

describe('planFleetFunding — requester persona', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function seed(patch: Partial<FleetState>): Promise<{ earningDir: string; master: string }> {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-req-'));
    dirs.push(earningDir);
    const mnemonic = generateMnemonic();
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'pw'));
    const master = deriveMasterAddress(mnemonic);
    await store.load('base-sepolia');
    await store.patchFleet({ master_address: master, ...patch });
    return { earningDir, master };
  }

  const zeroBalanceClient = () => ({ getBalance: vi.fn(async () => 0n) }) as any;

  it('defaults to the operator gate and its 0.02 ETH target', async () => {
    const { earningDir } = await seed({});
    const plan = await planFleetFunding({
      earningDir,
      chain: 'base-sepolia',
      chainConfigResolver: fakeChainConfig,
      publicClientFactory: zeroBalanceClient,
    });
    expect(plan.persona).toBe('operator');
    expect(BigInt(plan.master!.eth_required)).toBe(20_000_000_000_000_000n);
  });

  it('reports the requester shortfall when asked explicitly', async () => {
    const { earningDir } = await seed({});
    const plan = await planFleetFunding({
      earningDir,
      chain: 'base-sepolia',
      requester: true,
      chainConfigResolver: fakeChainConfig,
      publicClientFactory: zeroBalanceClient,
    });
    expect(plan.persona).toBe('requester');
    expect(BigInt(plan.master!.eth_required)).toBe(requesterMinMasterEth());
  });

  it('infers the requester once `jinn requester init` has run', async () => {
    const { earningDir } = await seed({ requester_stage: 'safe_deployed' });
    const plan = await planFleetFunding({
      earningDir,
      chain: 'base-sepolia',
      chainConfigResolver: fakeChainConfig,
      publicClientFactory: zeroBalanceClient,
    });
    expect(plan.persona).toBe('requester');
  });

  it('returns to the operator gate once the operator state machine advances', async () => {
    // A dual-role operator who ran `jinn requester init` first shares the very
    // same Safe. The moment they start the supplier path the operator target is
    // the honest answer again.
    const { earningDir } = await seed({ requester_stage: 'safe_deployed', fleet_stage: 'stage1' });
    const plan = await planFleetFunding({
      earningDir,
      chain: 'base-sepolia',
      chainConfigResolver: fakeChainConfig,
      publicClientFactory: zeroBalanceClient,
    });
    expect(plan.persona).toBe('operator');
  });
});
