/**
 * Unit tests for ClaimRegistryClient.
 * All viem interactions are mocked — no real chain required.
 *
 * claimJob() and releaseClaim() go through executeSafeTransaction (Safe multisig).
 * expireClaim() goes through walletClient.sendTransaction (EOA-direct, permissionless).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { ClaimRegistryClient, ZERO_ADDRESS } from '../../../src/adapters/claim-registry/client.js';

// ── Mock helpers ──────────────────────────────────────────────────────────────

const REGISTRY_ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const SAFE_ADDRESS     = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const OTHER_ADDRESS    = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const REQUEST_ID       = '0xdeadbeef00000000000000000000000000000000000000000000000000000000' as Hex;

const FUTURE_EXPIRES = BigInt(Math.floor(Date.now() / 1000) + 3600); // +1 h
const PAST_EXPIRES   = BigInt(Math.floor(Date.now() / 1000) - 60);   // -1 min (expired)

function makePublicClient(getJobClaimResult: [Address, bigint]): PublicClient {
  return {
    readContract: vi.fn().mockResolvedValue(getJobClaimResult),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    getBlock: vi.fn().mockResolvedValue({ number: 100n }),
    getTransactionCount: vi.fn().mockResolvedValue(1),
    estimateGas: vi.fn().mockResolvedValue(21000n),
  } as unknown as PublicClient;
}

function makeWalletClient(): WalletClient {
  return {
    sendTransaction: vi.fn().mockResolvedValue('0xabc123txhash' as Hex),
    account: { address: '0xeoa0000000000000000000000000000000000000' },
  } as unknown as WalletClient;
}

// Mock executeSafeTransaction so claimJob/releaseClaim don't need a real Safe
// MOCK_JUSTIFICATION: src/adapters/mech/safe.js is the I/O leaf for Safe wallet RPC calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/safe.js', () => ({
  executeSafeTransaction: vi.fn().mockResolvedValue('0xsafetxhash' as Hex),
}));

// Mock waitForTransactionReceiptWithRetry so tests don't need a real chain
// MOCK_JUSTIFICATION: src/tx-retry.js wraps chain-RPC retry logic at the I/O boundary; mocking it is mocking the boundary.
vi.mock('../../../src/tx-retry.js', () => ({
  waitForTransactionReceiptWithRetry: vi.fn().mockResolvedValue({ status: 'success' }),
  withRecoverableRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
  isRecoverableTransactionError: vi.fn().mockReturnValue(false),
  backoffDelay: vi.fn().mockResolvedValue(undefined),
  viemFeeOverridesForAttempt: vi.fn().mockReturnValue({}),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ClaimRegistryClient', () => {
  let publicClient: PublicClient;
  let walletClient: WalletClient;
  let client: ClaimRegistryClient;

  // Import executeSafeTransaction mock for assertions
  let mockExecuteSafeTransaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const safeMod = await import('../../../src/adapters/mech/safe.js');
    mockExecuteSafeTransaction = safeMod.executeSafeTransaction as ReturnType<typeof vi.fn>;
    mockExecuteSafeTransaction.mockClear();
    mockExecuteSafeTransaction.mockResolvedValue('0xsafetxhash' as Hex);
  });

  // ── getJobClaim ─────────────────────────────────────────────────────────────

  describe('getJobClaim', () => {
    it('returns active=false when contract returns zero address', async () => {
      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const info = await client.getJobClaim(REQUEST_ID);
      expect(info.claimer).toBe(ZERO_ADDRESS);
      expect(info.expiresAt).toBe(0n);
      expect(info.isActive).toBe(false);
    });

    it('returns active=true when claim exists and has future expiresAt', async () => {
      publicClient = makePublicClient([SAFE_ADDRESS, FUTURE_EXPIRES]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const info = await client.getJobClaim(REQUEST_ID);
      expect(info.claimer).toBe(SAFE_ADDRESS);
      expect(info.isActive).toBe(true);
    });

    it('returns active=false when expiresAt is 0 (contract already cleared it)', async () => {
      // Contract's getJobClaim returns (address(0), 0) for expired claims
      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const info = await client.getJobClaim(REQUEST_ID);
      expect(info.isActive).toBe(false);
    });
  });

  // ── weAlreadyClaimed ────────────────────────────────────────────────────────

  describe('weAlreadyClaimed', () => {
    it('returns true when Safe holds the active claim', async () => {
      publicClient = makePublicClient([SAFE_ADDRESS, FUTURE_EXPIRES]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      expect(await client.weAlreadyClaimed(REQUEST_ID)).toBe(true);
    });

    it('returns false when no claim exists', async () => {
      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      expect(await client.weAlreadyClaimed(REQUEST_ID)).toBe(false);
    });

    it('returns false when a different address holds the claim', async () => {
      publicClient = makePublicClient([OTHER_ADDRESS, FUTURE_EXPIRES]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      expect(await client.weAlreadyClaimed(REQUEST_ID)).toBe(false);
    });
  });

  // ── claimJob ────────────────────────────────────────────────────────────────

  describe('claimJob', () => {
    it('skips Safe tx and returns claimed=true when Safe already has claim', async () => {
      publicClient = makePublicClient([SAFE_ADDRESS, FUTURE_EXPIRES]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const result = await client.claimJob(REQUEST_ID);
      expect(result.claimed).toBe(true);
      expect(result.txHash).toBe('');
      expect(mockExecuteSafeTransaction).not.toHaveBeenCalled();
    });

    it('returns claimed=false when another address holds the claim', async () => {
      publicClient = makePublicClient([OTHER_ADDRESS, FUTURE_EXPIRES]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const result = await client.claimJob(REQUEST_ID);
      expect(result.claimed).toBe(false);
      expect(mockExecuteSafeTransaction).not.toHaveBeenCalled();
    });

    it('sends Safe tx and returns claimed=true when no existing claim', async () => {
      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const result = await client.claimJob(REQUEST_ID);
      expect(result.claimed).toBe(true);
      expect(result.txHash).toBe('0xsafetxhash');
      expect(mockExecuteSafeTransaction).toHaveBeenCalledOnce();
      // Verify the Safe address and target contract are correct
      expect(mockExecuteSafeTransaction).toHaveBeenCalledWith(
        publicClient,
        walletClient,
        expect.objectContaining({ safeAddress: SAFE_ADDRESS, to: REGISTRY_ADDRESS, value: 0n }),
      );
    });

    it('returns claimed=false when Safe tx reverts with JobAlreadyClaimed', async () => {
      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      mockExecuteSafeTransaction.mockRejectedValueOnce(new Error('JobAlreadyClaimed: someone else'));
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const result = await client.claimJob(REQUEST_ID);
      expect(result.claimed).toBe(false);
    });

    it('returns claimed=false when Safe tx reverts with IneligibleToClaim', async () => {
      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      mockExecuteSafeTransaction.mockRejectedValueOnce(new Error('IneligibleToClaim: not in whitelist'));
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const result = await client.claimJob(REQUEST_ID);
      expect(result.claimed).toBe(false);
    });

    it('throws on unrecognised RPC errors', async () => {
      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      mockExecuteSafeTransaction.mockRejectedValueOnce(new Error('ECONNREFUSED: node is down'));
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      await expect(client.claimJob(REQUEST_ID)).rejects.toThrow('ECONNREFUSED');
    });

    // ── #8 receipt-wait tests ───────────────────────────────────────────────────

    it('throws when the tx receipt status is "reverted"', async () => {
      const { waitForTransactionReceiptWithRetry } = await import('../../../src/tx-retry.js');
      vi.mocked(waitForTransactionReceiptWithRetry).mockResolvedValueOnce({
        status: 'reverted',
        transactionHash: '0xsafetxhash',
      } as unknown as Awaited<ReturnType<typeof waitForTransactionReceiptWithRetry>>);

      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      await expect(client.claimJob(REQUEST_ID)).rejects.toThrow(/claimJob transaction reverted/);
    });

    it('does not return until the receipt resolves', async () => {
      // Gate the receipt behind a manually controlled promise
      let resolveReceipt!: (v: unknown) => void;
      const receiptGate = new Promise(resolve => { resolveReceipt = resolve; });

      const { waitForTransactionReceiptWithRetry } = await import('../../../src/tx-retry.js');
      vi.mocked(waitForTransactionReceiptWithRetry).mockImplementationOnce(
        () => receiptGate as Promise<{ status: string }>,
      );

      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      let settled = false;
      const claimPromise = client.claimJob(REQUEST_ID).then(r => { settled = true; return r; });

      // Allow microtasks to run — claimJob must NOT have resolved yet
      await Promise.resolve();
      expect(settled).toBe(false);

      // Ungate the receipt
      resolveReceipt({ status: 'success', transactionHash: '0xsafetxhash' });
      const result = await claimPromise;

      expect(settled).toBe(true);
      expect(result.claimed).toBe(true);
    });
  });

  // ── releaseClaim ────────────────────────────────────────────────────────────

  describe('releaseClaim', () => {
    it('returns false without sending Safe tx when no active claim', async () => {
      publicClient = makePublicClient([ZERO_ADDRESS, 0n]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const released = await client.releaseClaim(REQUEST_ID);
      expect(released).toBe(false);
      expect(mockExecuteSafeTransaction).not.toHaveBeenCalled();
    });

    it('returns false without sending Safe tx when another address holds the claim', async () => {
      publicClient = makePublicClient([OTHER_ADDRESS, FUTURE_EXPIRES]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const released = await client.releaseClaim(REQUEST_ID);
      expect(released).toBe(false);
      expect(mockExecuteSafeTransaction).not.toHaveBeenCalled();
    });

    it('sends Safe tx and returns true when Safe holds the claim', async () => {
      publicClient = makePublicClient([SAFE_ADDRESS, FUTURE_EXPIRES]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const released = await client.releaseClaim(REQUEST_ID);
      expect(released).toBe(true);
      expect(mockExecuteSafeTransaction).toHaveBeenCalledOnce();
      expect(mockExecuteSafeTransaction).toHaveBeenCalledWith(
        publicClient,
        walletClient,
        expect.objectContaining({ safeAddress: SAFE_ADDRESS, to: REGISTRY_ADDRESS, value: 0n }),
      );
    });

    it('returns false when Safe tx reverts with NotClaimOwner', async () => {
      publicClient = makePublicClient([SAFE_ADDRESS, FUTURE_EXPIRES]);
      walletClient = makeWalletClient();
      mockExecuteSafeTransaction.mockRejectedValueOnce(new Error('NotClaimOwner: race'));
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const released = await client.releaseClaim(REQUEST_ID);
      expect(released).toBe(false);
    });
  });

  // ── expireClaim ─────────────────────────────────────────────────────────────

  describe('expireClaim', () => {
    it('sends EOA tx (not Safe) and returns true for an expired claim', async () => {
      // expireClaim is permissionless GC — goes through EOA directly (cheaper)
      publicClient = makePublicClient([OTHER_ADDRESS, PAST_EXPIRES]);
      walletClient = makeWalletClient();
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const expired = await client.expireClaim(REQUEST_ID);
      expect(expired).toBe(true);
      // Should use EOA sendTransaction, NOT the Safe
      expect(walletClient.sendTransaction).toHaveBeenCalledOnce();
      expect(mockExecuteSafeTransaction).not.toHaveBeenCalled();
    });

    it('returns false when tx reverts with ClaimNotExpired', async () => {
      publicClient = makePublicClient([OTHER_ADDRESS, FUTURE_EXPIRES]);
      walletClient = {
        sendTransaction: vi.fn().mockRejectedValue(new Error('ClaimNotExpired: still active')),
        account: { address: '0xeoa0000000000000000000000000000000000000' },
      } as unknown as WalletClient;
      client = new ClaimRegistryClient(publicClient, walletClient, REGISTRY_ADDRESS, SAFE_ADDRESS);

      const expired = await client.expireClaim(REQUEST_ID);
      expect(expired).toBe(false);
    });
  });
});
