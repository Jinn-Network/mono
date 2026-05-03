/**
 * Tests for the cross-chain JINN claim loop (jinn-mono-7x5 daemon side).
 *
 * The L1/L2 viem clients are stubbed end-to-end so we exercise the
 * orchestrator's branching (mock vs canonical), the per-tick iteration over
 * staked services, and the contract calls each mode makes. Real OP-Stack
 * proof construction is out of scope here — covered by the contract-side
 * fixture tests.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  JinnClaimLoop,
  type JinnClaimLoopConfig,
} from '../../src/daemon/jinn-claim-loop.js';
import { CLAIM_TICKET_TOPIC0 } from '../../src/earning/contracts.js';

const SERVICE_ID = 7n;
const MULTISIG = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const AGENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const MASTER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;
const CLAIM_EMITTER = '0x1111111111111111111111111111111111111111' as const;
const DISTRIBUTOR = '0x2222222222222222222222222222222222222222' as const;
const MESSENGER = '0x3333333333333333333333333333333333333333' as const;
const OPTIMISM_PORTAL = '0x4444444444444444444444444444444444444444' as const;
const DGF = '0x5555555555555555555555555555555555555555' as const;
const CLAIM_ID = 101n;

function fleetStoreWithService(opts: { step?: 'complete' | 'mech_deployed' | 'awaiting_stake' } = {}) {
  return {
    load: vi.fn(async () => ({
      master_address: MASTER,
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: AGENT,
          safe_address: MULTISIG,
          service_id: Number(SERVICE_ID),
          mech_address: null,
          staking_address: null,
          step: opts.step ?? 'complete',
          error: null,
        },
      ],
      updated_at: '2026-04-27T00:00:00Z',
    })),
  } as any;
}

function emptyFleetStore() {
  return {
    load: vi.fn(async () => ({
      master_address: MASTER,
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [],
      updated_at: '2026-04-27T00:00:00Z',
    })),
  } as any;
}

function mockL2Client(opts: { emitTxHash?: `0x${string}`; emitBlock?: bigint } = {}) {
  const txHash = opts.emitTxHash ?? '0xaabb';
  const block = opts.emitBlock ?? 100n;

  return {
    simulateContract: vi.fn(async () => ({
      request: { kind: 'l2-emit', hash: txHash },
    })),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: 'success',
      blockNumber: block,
      transactionHash: txHash,
      logs: [],
    })),
    getTransactionReceipt: vi.fn(async () => ({
      blockNumber: block,
      transactionHash: txHash,
      status: 'success',
      logs: [
        {
          address: CLAIM_EMITTER,
          topics: [
            CLAIM_TICKET_TOPIC0,
            '0x' + CLAIM_ID.toString(16).padStart(64, '0'),
            '0x' + SERVICE_ID.toString(16).padStart(64, '0'),
            '0x' + MULTISIG.slice(2).padStart(64, '0'),
          ],
          data: '0x' + (3n).toString(16).padStart(64, '0')
                + (5n).toString(16).padStart(64, '0')
                + (2n).toString(16).padStart(64, '0')
                + MASTER.slice(2).padStart(64, '0'),
          logIndex: 0,
          blockNumber: block,
          transactionHash: txHash,
        },
      ],
    })),
    getLogs: vi.fn(async () => [
      {
        address: CLAIM_EMITTER,
        // decodeEventLog reads args from data + topics; we shortcut with a
        // synthetic decoded payload via the abi.
        data: '0x' + (3n).toString(16).padStart(64, '0')      // taskCreationWeight = 3
              + (5n).toString(16).padStart(64, '0')           // novelty
              + (2n).toString(16).padStart(64, '0')           // eval
              + MASTER.slice(2).padStart(64, '0'),            // claimer
        topics: [
          CLAIM_TICKET_TOPIC0,
          '0x' + CLAIM_ID.toString(16).padStart(64, '0'),
          '0x' + SERVICE_ID.toString(16).padStart(64, '0'),
          '0x' + MULTISIG.slice(2).padStart(64, '0'),
        ],
        logIndex: 0,
        blockNumber: block,
        transactionHash: txHash,
        removed: false,
      },
    ]),
  } as any;
}

function mockL2Wallet() {
  return {
    account: { address: AGENT },
    writeContract: vi.fn(async (req: any) => req.hash ?? '0xaabb'),
  } as any;
}

function mockL1Client(opts: { txHash?: `0x${string}` } = {}) {
  const hash = opts.txHash ?? '0xccdd';
  return {
    simulateContract: vi.fn(async () => ({ request: { kind: 'l1-call', hash } })),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', transactionHash: hash })),
  } as any;
}

function mockL1Wallet() {
  return {
    account: { address: MASTER },
    writeContract: vi.fn(async (req: any) => req.hash ?? '0xccdd'),
  } as any;
}

function baseConfig(overrides: Partial<JinnClaimLoopConfig> = {}): JinnClaimLoopConfig {
  return {
    intervalMs: 60_000,
    l2Client: mockL2Client(),
    l2Wallet: mockL2Wallet(),
    l1Client: mockL1Client(),
    l1Wallet: mockL1Wallet(),
    store: fleetStoreWithService(),
    chain: 'base-sepolia',
    claimEmitterAddress: CLAIM_EMITTER,
    distributorAddress: DISTRIBUTOR,
    messengerAddress: MESSENGER,
    messengerMode: 'mock',
    ...overrides,
  };
}

describe('JinnClaimLoop', () => {
  describe('mock mode', () => {
    it('emits ClaimTicket on L2 and submits fixture + claim on L1', async () => {
      const cfg = baseConfig();
      const loop = new JinnClaimLoop(cfg);
      const result = await loop.runOnce();

      expect(result).toMatchObject({ ticks: 1, emits: 1, submits: 1, errors: 0 });

      // L2: simulateContract for emitClaim, then writeContract.
      expect(cfg.l2Client.simulateContract).toHaveBeenCalledTimes(1);
      expect((cfg.l2Client.simulateContract as any).mock.calls[0][0]).toMatchObject({
        address: CLAIM_EMITTER,
        functionName: 'emitClaim',
        args: [SERVICE_ID],
      });

      // L1: simulateContract twice — setFixture then claim.
      expect(cfg.l1Client.simulateContract).toHaveBeenCalledTimes(2);
      const calls = (cfg.l1Client.simulateContract as any).mock.calls;
      expect(calls[0][0]).toMatchObject({ address: MESSENGER, functionName: 'setFixture' });
      expect(calls[1][0]).toMatchObject({
        address: DISTRIBUTOR,
        functionName: 'claim',
      });
    });

    it('rejects when L2 multisig does not match service multisig', async () => {
      // L2 returns a snapshot for a different multisig.
      const otherMultisig = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;
      const l2 = mockL2Client();
      // Override getLogs to return a log decoding to a different multisig.
      l2.getLogs = vi.fn(async () => [
        {
          address: CLAIM_EMITTER,
          data: '0x' + (3n).toString(16).padStart(64, '0')
                + (5n).toString(16).padStart(64, '0')
                + (2n).toString(16).padStart(64, '0')
                + MASTER.slice(2).padStart(64, '0'),
          topics: [
            CLAIM_TICKET_TOPIC0,
            '0x' + CLAIM_ID.toString(16).padStart(64, '0'),
            '0x' + SERVICE_ID.toString(16).padStart(64, '0'),
            '0x' + otherMultisig.slice(2).padStart(64, '0'),
          ],
          logIndex: 0,
          blockNumber: 100n,
          transactionHash: '0xaabb',
          removed: false,
        },
      ]);

      const cfg = baseConfig({ l2Client: l2 });
      const loop = new JinnClaimLoop(cfg);
      const result = await loop.runOnce();

      expect(result.errors).toBe(1);
      // L1 setFixture must NOT have been called.
      expect(cfg.l1Client.simulateContract).not.toHaveBeenCalled();
    });

    it('skips services that are not yet staked / complete', async () => {
      const cfg = baseConfig({ store: fleetStoreWithService({ step: 'awaiting_stake' }) });
      const loop = new JinnClaimLoop(cfg);
      const result = await loop.runOnce();

      expect(result).toEqual({ ticks: 0, emits: 0, submits: 0, errors: 0 });
      expect(cfg.l2Client.simulateContract).not.toHaveBeenCalled();
      expect(cfg.l1Client.simulateContract).not.toHaveBeenCalled();
    });

    it('returns zero counters when fleet has no services', async () => {
      const cfg = baseConfig({ store: emptyFleetStore() });
      const loop = new JinnClaimLoop(cfg);
      const result = await loop.runOnce();
      expect(result).toEqual({ ticks: 0, emits: 0, submits: 0, errors: 0 });
    });
  });

  describe('canonical mode', () => {
    it('runOnce skips automated canonical ticks without emitting', async () => {
      const cfg = baseConfig({
        messengerMode: 'canonical',
        optimismPortalAddress: OPTIMISM_PORTAL,
        disputeGameFactoryAddress: DGF,
      });
      const loop = new JinnClaimLoop(cfg);
      const result = await loop.runOnce();

      expect(result).toEqual({ ticks: 0, emits: 0, submits: 0, errors: 0 });
      expect(cfg.l2Client.simulateContract).not.toHaveBeenCalled();
      expect(cfg.l1Client.simulateContract).not.toHaveBeenCalled();
    });

    it('tickService still emits on L2 then fails before L1 when canonical proof is not ready', async () => {
      const cfg = baseConfig({
        messengerMode: 'canonical',
        optimismPortalAddress: OPTIMISM_PORTAL,
        disputeGameFactoryAddress: DGF,
      });
      const loop = new JinnClaimLoop(cfg);
      const acc = { ticks: 0, emits: 0, submits: 0, errors: 0 };

      await expect(
        loop.tickService({
          serviceId: SERVICE_ID,
          displayIndex: 1,
          multisig: MULTISIG,
        }, acc),
      ).rejects.toThrow();

      expect(acc.ticks).toBe(0);
      expect(acc.emits).toBe(1);
      expect(acc.submits).toBe(0);
      expect(cfg.l2Client.simulateContract).toHaveBeenCalledTimes(1);
      expect(cfg.l1Client.simulateContract).not.toHaveBeenCalled();
    });

    it('tickService refuses canonical submit without portal/DGF wiring', async () => {
      const cfg = baseConfig({ messengerMode: 'canonical' });
      const loop = new JinnClaimLoop(cfg);
      const acc = { ticks: 0, emits: 0, submits: 0, errors: 0 };

      await expect(
        loop.tickService({
          serviceId: SERVICE_ID,
          displayIndex: 1,
          multisig: MULTISIG,
        }, acc),
      ).rejects.toThrow(/optimismPortalAddress/);

      expect(acc.emits).toBe(1);
    });
  });

  describe('disabled state', () => {
    it('run() is a no-op when intervalMs <= 0', async () => {
      const cfg = baseConfig({ intervalMs: 0 });
      const loop = new JinnClaimLoop(cfg);
      // run() should resolve immediately.
      await loop.run();
      expect(cfg.l2Client.simulateContract).not.toHaveBeenCalled();
    });
  });
});
