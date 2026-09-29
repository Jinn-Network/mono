/**
 * #4827 — pin the agent-EOA balance wait at its `stepFleetSafeDeploy` call
 * site. Every existing suite that reaches this step stubs it
 * (`requester-init.test.ts:119/155/262`, `staged-bootstrap-stage1.test.ts`,
 * `staged-bootstrap-stage1and2.test.ts`), so nothing pinned that the wait runs
 * between the funding receipt and the Safe factory call, and nothing pinned
 * that it targets the post-transfer balance rather than the transferred delta.
 * Both were silently reversible.
 *
 * Mechanism: the real `createJinnPublicClient` / `createJinnWalletClient`
 * point at the in-process JSON-RPC boundary fake, so the real
 * `viemSendTransactionWithRetry`, `waitForTransactionReceiptWithRetry` and
 * `waitForNativeBalanceAtLeast` all execute and the ordering assertion falls
 * out of the server's own method log.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import * as safeAdapter from '../../../src/earning/safe-adapter.js';
import { stepFleetSafeDeploy } from '../../../src/earning/steps/fleet-safe-deploy.js';
import type { StepContext } from '../../../src/earning/steps/context.js';
import { FleetStateStore } from '../../../src/earning/store.js';
import { getChainConfig } from '../../../src/earning/contracts.js';
import { createJinnPublicClient } from '../../../src/earning/viem-clients.js';
import {
  deriveAgentAddress,
  deriveMasterAddress,
  generateMnemonic,
} from '../../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../../src/earning/types.js';
import { REQUESTER_SAFE_DEPLOY_ETH } from '../../../src/earning/requester-init.js';
import { startFakeRpc, type FakeRpc } from '../../_support/chain/fake-rpc.js';

// MOCK_JUSTIFICATION: @safe-global/protocol-kit is a third-party SDK reached
// through safe-adapter.js; `initPredictedSafe` constructs it internally with
// no DI seam. Precedent: test/earning/bootstrap-mech-safe-direct.test.ts.
vi.mock('../../../src/earning/safe-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/earning/safe-adapter.js')>();
  return { ...actual, initPredictedSafe: vi.fn() };
});

const FLEET_SAFE = '0xBBBB000000000000000000000000000000000002';
const FUNDING = REQUESTER_SAFE_DEPLOY_ETH;

describe('stepFleetSafeDeploy agent-EOA balance wait', () => {
  const dirs: string[] = [];
  const servers: FakeRpc[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /**
   * Builds the `StepContext` over a real `FleetStateStore` and a real public
   * client pointed at the fake. Only the four fields `stepFleetSafeDeploy`
   * reads are populated; the rest of the seventeen-field bag is cast away
   * rather than stubbed.
   */
  function makeStepContext(overrides: Partial<StepContext> = {}): StepContext {
    return { chain: 'base-sepolia', ...overrides } as unknown as StepContext;
  }

  async function setup(balances: bigint[]): Promise<{
    ctx: StepContext;
    state: Awaited<ReturnType<FleetStateStore['load']>>;
    events: string[];
    mnemonic: string;
    agentAddress: string;
  }> {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fsd-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const agentAddress = deriveAgentAddress(mnemonic, 1);

    const store = new FleetStateStore(earningDir);
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: deriveMasterAddress(mnemonic),
      fleet_safe_address: FLEET_SAFE,
    });

    const events: string[] = [];
    let balanceCall = 0;
    const fake = await startFakeRpc({
      eth_getBalance: () => {
        events.push('eth_getBalance');
        const idx = Math.min(balanceCall++, balances.length - 1);
        return `0x${balances[idx]!.toString(16)}`;
      },
      eth_sendRawTransaction: () => {
        events.push('eth_sendRawTransaction');
        return `0x${'ab'.repeat(32)}`;
      },
      eth_getTransactionReceipt: (params: unknown[]) => {
        events.push('eth_getTransactionReceipt');
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
          status: '0x1',
          effectiveGasPrice: '0x3b9aca00',
          type: '0x2',
        };
      },
    });
    servers.push(fake);

    vi.mocked(safeAdapter.initPredictedSafe).mockImplementation(async () => {
      events.push('initPredictedSafe');
      return {
        address: FLEET_SAFE,
        safe: {
          createSafeDeploymentTransaction: async () => ({
            to: getAddress('0x4444444444444444444444444444444444444444'),
            value: '0',
            data: '0x1234',
          }),
        },
      } as any;
    });

    const config = getChainConfig('base-sepolia');
    config.rpcUrl = fake.url;
    const ctx = makeStepContext({
      store,
      config,
      publicClient: createJinnPublicClient(fake.url, 'base-sepolia'),
      rpcUrls: [fake.url],
    });

    return { ctx, state: await store.load('base-sepolia'), events, mnemonic, agentAddress };
  }

  it('funds the agent EOA, waits for the funded balance, then calls the Safe factory', async () => {
    const { ctx, state, events, mnemonic } = await setup([FUNDING / 2n, FUNDING]);

    await stepFleetSafeDeploy(ctx, state, mnemonic, FUNDING);

    const upTo = events.slice(0, events.indexOf('initPredictedSafe') + 1);
    expect(upTo).toEqual([
      'eth_getBalance',
      'eth_sendRawTransaction',
      'eth_getTransactionReceipt',
      'eth_getBalance',
      'initPredictedSafe',
    ]);
  }, 30_000);

  it('waits for the post-transfer target, not the transferred delta', async () => {
    // Discriminating fixture. The agent starts at half the target, so
    // `fundAmount` = FUNDING / 2; every post-transfer read is one wei short.
    //   target = agentFundingWei (correct) -> never satisfied -> rejects.
    //   target = fundAmount -> FUNDING - 1 >= FUNDING / 2 -> satisfied on the
    //     first poll -> the Safe factory is reached.
    // Opposite observable outcomes, and the pin survives refactors that change
    // how the helper is called.
    const { ctx, state, mnemonic } = await setup([FUNDING / 2n, FUNDING - 1n]);

    await expect(stepFleetSafeDeploy(ctx, state, mnemonic, FUNDING)).rejects.toThrow();
    expect(safeAdapter.initPredictedSafe).not.toHaveBeenCalled();
  }, 30_000);

  it('skips the funding transfer when the agent is already at the target', async () => {
    const { ctx, state, events, mnemonic } = await setup([FUNDING]);

    await stepFleetSafeDeploy(ctx, state, mnemonic, FUNDING);

    const upTo = events.slice(0, events.indexOf('initPredictedSafe'));
    expect(upTo).toEqual(['eth_getBalance']);
  }, 30_000);
});
