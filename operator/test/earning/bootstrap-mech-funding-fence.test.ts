/**
 * #4825 — the mech-deploy funding site is a fund-then-spend pair, and the
 * spend is the largest single gas requirement in the bootstrap (~2.6M gas for
 * the mech-create Safe tx). Before this fence it waited for the funding
 * *receipt* and then spent immediately, which a node that has not yet seen
 * that block answers with `gas required exceeds allowance (0)`.
 *
 * The bootstrapper is pointed at the in-process fake JSON-RPC boundary
 * (`test/_support/chain/fake-rpc.ts`) so the real `viemSendTransactionWithRetry`,
 * `waitForTransactionReceiptWithRetry` and `waitForNativeBalanceAtLeast` all
 * execute — the ordering assertion then falls out of the server's own method
 * log rather than out of which internal helper the test chose to observe.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as safeAdapter from '../../src/earning/safe-adapter.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  deriveAgentAddress,
  deriveMasterAddress,
  generateMnemonic,
} from '../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../src/earning/types.js';
import { startFakeRpc, type FakeRpc } from '../_support/chain/fake-rpc.js';

// MOCK_JUSTIFICATION: @safe-global/protocol-kit is a third-party SDK boundary
// reached through safe-adapter.js; stepDeployMech constructs it internally
// with no DI seam. Precedent: test/earning/bootstrap-mech-safe-direct.test.ts.
vi.mock('../../src/earning/safe-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/earning/safe-adapter.js')>();
  return { ...actual, initDeployedSafe: vi.fn(), executeSafeTxDirect: vi.fn() };
});

/** base-sepolia `minEoaGasEth`. */
const MIN_EOA_GAS = 5_000_000_000_000_000n;
const SAFE_ADDRESS = '0x2222222222222222222222222222222222222222';
const MECH_ADDRESS = '0x3333333333333333333333333333333333333333';
const CREATE_MECH_TOPIC =
  '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6';

function toHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

describe('stepDeployMech agent-EOA funding fence', () => {
  const dirs: string[] = [];
  const servers: FakeRpc[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /**
   * Seeds a staked, mech-less service and returns the bootstrapper pointed at
   * a fake RPC whose `eth_getBalance` is driven by `balances`: the first entry
   * answers the pre-funding read, the last entry repeats forever after.
   */
  async function setup(balances: bigint[]): Promise<{
    bootstrapper: FleetBootstrapper;
    store: FleetStateStore;
    fake: FakeRpc;
    events: string[];
    agentAddress: string;
    mnemonic: string;
  }> {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-mech-fence-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const masterAddress = deriveMasterAddress(mnemonic);
    const agentAddress = deriveAgentAddress(mnemonic, 1);

    const store = new FleetStateStore(earningDir);
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: masterAddress,
      services: [
        {
          index: 1,
          agent_address: agentAddress,
          safe_address: SAFE_ADDRESS,
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
          error_revert_reason: null,
          error_short_message: null,
        },
      ],
    });

    const events: string[] = [];
    let balanceCall = 0;
    const fake = await startFakeRpc({
      eth_getBalance: () => {
        events.push('getBalance');
        const idx = Math.min(balanceCall++, balances.length - 1);
        return toHex(balances[idx]!);
      },
      eth_sendRawTransaction: () => {
        events.push('sendTransaction');
        return `0x${'ab'.repeat(32)}`;
      },
      eth_getTransactionReceipt: (params: unknown[]) => {
        events.push('receipt');
        return {
          transactionHash: String(params[0]),
          transactionIndex: '0x0',
          blockHash: `0x${'11'.repeat(32)}`,
          blockNumber: '0x10',
          from: `0x${'00'.repeat(20)}`,
          to: `0x${'00'.repeat(20)}`,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          contractAddress: null,
          logs: [
            {
              address: `0x${'00'.repeat(20)}`,
              topics: [
                CREATE_MECH_TOPIC,
                `0x${'0'.repeat(24)}${MECH_ADDRESS.slice(2).toLowerCase()}`,
              ],
              data: '0x',
              blockNumber: '0x10',
              blockHash: `0x${'11'.repeat(32)}`,
              transactionHash: String(params[0]),
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: false,
            },
          ],
          logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x1',
          effectiveGasPrice: '0x3b9aca00',
          type: '0x2',
        };
      },
    });
    servers.push(fake);

    vi.mocked(safeAdapter.executeSafeTxDirect).mockImplementation(async () => {
      events.push('executeSafeTxDirect');
      return { hash: `0x${'cd'.repeat(32)}` as `0x${string}` };
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: fake.url,
      stakingMode: 'standard',
    });

    return { bootstrapper, store, fake, events, agentAddress, mnemonic };
  }

  it('waits for the funded balance before spending from the agent EOA', async () => {
    // Pre-funding balance below the target takes the funding branch; every
    // later read is at the target so the wait clears on its first poll.
    const { bootstrapper, store, events, mnemonic } = await setup([
      1_000_000_000_000_000n,
      MIN_EOA_GAS,
    ]);

    const state = await store.load('base-sepolia');
    await (bootstrapper as any).stepDeployMech(state, mnemonic, 1);

    // The balance wait sits between the funding receipt and the spend.
    expect(events).toEqual([
      'getBalance',
      'sendTransaction',
      'receipt',
      'getBalance',
      'executeSafeTxDirect',
      'receipt',
    ]);
  }, 30_000);

  it('waits for the post-transfer target, not the transferred delta', async () => {
    // Discriminating fixture. Agent starts at half the target, so
    // `fundAmount` = MIN_EOA_GAS / 2; every post-transfer read is one wei
    // short of the target.
    //   target = minEoaGasEth (correct) -> never satisfied -> throws.
    //   target = fundAmount (the delta) -> MIN_EOA_GAS - 1 >= MIN_EOA_GAS / 2
    //     -> satisfied on the first poll -> the Safe tx is sent.
    // The two hypotheses have opposite observable outcomes.
    const { bootstrapper, store, mnemonic } = await setup([
      MIN_EOA_GAS / 2n,
      MIN_EOA_GAS - 1n,
    ]);

    const state = await store.load('base-sepolia');
    // Pin the helper's own exhaustion message: a bare `toThrow()` would also
    // be satisfied by a fixture error thrown before the wait is ever reached.
    await expect((bootstrapper as any).stepDeployMech(state, mnemonic, 1))
      .rejects.toThrow(/Balance at 0x[0-9a-fA-F]{40} is .* after \d+ getBalance attempts/);

    expect(safeAdapter.executeSafeTxDirect).not.toHaveBeenCalled();
  }, 30_000);

  it('surfaces a reverted funding transfer as a transaction failure, not a balance problem', async () => {
    const { bootstrapper, store, fake, events, mnemonic } = await setup([
      1_000_000_000_000_000n,
      MIN_EOA_GAS,
    ]);
    const fundHash = `0x${'ab'.repeat(32)}`;
    fake.on('eth_getTransactionReceipt', (params: unknown[]) => {
      events.push('receipt');
      return {
        transactionHash: String(params[0]),
        transactionIndex: '0x0',
        blockHash: `0x${'11'.repeat(32)}`,
        blockNumber: '0x10',
        from: `0x${'00'.repeat(20)}`,
        to: `0x${'00'.repeat(20)}`,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x0',
        effectiveGasPrice: '0x3b9aca00',
        type: '0x2',
      };
    });

    const state = await store.load('base-sepolia');
    await expect((bootstrapper as any).stepDeployMech(state, mnemonic, 1))
      .rejects.toThrow(fundHash);

    // The throw precedes the wait, so no second balance read and no spend.
    expect(safeAdapter.executeSafeTxDirect).not.toHaveBeenCalled();
    expect(events.filter((e) => e === 'getBalance')).toHaveLength(1);
  }, 30_000);
});
