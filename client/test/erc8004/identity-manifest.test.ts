import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  IDENTITY_REGISTRY_SET_METADATA_ABI,
  IdentityPublisher,
} from '../../src/erc8004/identity.js';
import {
  encodeManifestPayload,
  type ManifestPayload,
} from '../../src/erc8004/manifest-registry.js';
import {
  getDefaultTxSubmissionLedger,
  setDefaultTxSubmissionLedger,
} from '../../src/tx-retry.js';

const REGISTRY = '0x8004800480048004800480048004800480048004' as Hex;
const TX_HASH = `0x${'fe'.repeat(32)}` as Hex;
const ROOT = `0x${'ab'.repeat(32)}` as Hex;
const PAYLOAD: ManifestPayload = {
  version: 0,
  merkleRoot: ROOT,
  memberCount: 3,
  createdAt: 1_700_000_000,
};

function makePublisher(
  receipt:
    | {
        blockNumber: bigint;
        gasUsed: bigint;
        effectiveGasPrice?: bigint;
        status?: 'success' | 'reverted';
      }
    | Error,
) {
  const sendTransaction = vi.fn().mockResolvedValue(TX_HASH);
  const waitForTransactionReceipt =
    receipt instanceof Error
      ? vi.fn().mockRejectedValue(receipt)
      : vi.fn().mockResolvedValue(receipt);
  const walletClient = {
    account: { address: '0x1111111111111111111111111111111111111111' },
    chain: { id: 8453, name: 'base' },
    sendTransaction,
  } as unknown as WalletClient;
  const publicClient = {
    waitForTransactionReceipt,
    getTransactionReceipt: vi.fn(),
    getChainId: vi.fn().mockResolvedValue(8453),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    estimateFeesPerGas: vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    }),
    getGasPrice: vi.fn().mockResolvedValue(50n),
  } as unknown as PublicClient;
  return {
    publisher: new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: 42n,
      walletClient,
      publicClient,
    }),
    sendTransaction,
    waitForTransactionReceipt,
    getTransactionReceipt: publicClient.getTransactionReceipt,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IdentityPublisher.publishManifest', () => {
  it('writes manifest:<cid> and returns receipt gas plus the effective fee', async () => {
    const { publisher, sendTransaction } = makePublisher({
      blockNumber: 123n,
      gasUsed: 21_000n,
      effectiveGasPrice: 2n,
      status: 'success',
    });

    const result = await publisher.publishManifest({
      manifestCid: 'bafy-manifest',
      payload: PAYLOAD,
    });

    expect(result).toEqual({
      txHash: TX_HASH,
      blockNumber: 123,
      gasUsed: 21_000n,
      feeWei: 42_000n,
    });
    const sent = sendTransaction.mock.calls[0]?.[0] as { to: Hex; data: Hex };
    const decoded = decodeFunctionData({
      abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
      data: sent.data,
    });
    expect(sent.to).toBe(REGISTRY);
    expect(decoded.args).toEqual([
      42n,
      'manifest:bafy-manifest',
      encodeManifestPayload(PAYLOAD),
    ]);
  });

  it('fails closed when the manifest receipt cannot be confirmed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { publisher } = makePublisher(new Error('receipt RPC unavailable'));

    await expect(
      publisher.publishManifest({
        manifestCid: 'bafy-manifest',
        payload: PAYLOAD,
      }),
    ).rejects.toThrow(/receipt.*0xfefefe/i);
  });

  it('preserves gasUsed but reports a null fee when effectiveGasPrice is absent', async () => {
    const { publisher } = makePublisher({
      blockNumber: 124n,
      gasUsed: 22_000n,
      status: 'success',
    });

    await expect(
      publisher.publishManifest({
        manifestCid: 'bafy-manifest',
        payload: PAYLOAD,
      }),
    ).resolves.toMatchObject({
      blockNumber: 124,
      gasUsed: 22_000n,
      feeWei: null,
    });
  });

  it('rejects a reverted manifest transaction instead of reporting it as anchored', async () => {
    const { publisher } = makePublisher({
      blockNumber: 125n,
      gasUsed: 23_000n,
      effectiveGasPrice: 2n,
      status: 'reverted',
    });

    await expect(
      publisher.publishManifest({
        manifestCid: 'bafy-manifest',
        payload: PAYLOAD,
      }),
    ).rejects.toThrow(/reverted.*0xfefefe/i);
  });

  it('records the broadcast hash before waiting for the receipt', async () => {
    const onBroadcast = vi.fn();
    const { publisher, waitForTransactionReceipt } = makePublisher({
      blockNumber: 126n,
      gasUsed: 24_000n,
      effectiveGasPrice: 2n,
      status: 'success',
    });
    waitForTransactionReceipt.mockImplementationOnce(async () => {
      expect(onBroadcast).toHaveBeenCalledWith(TX_HASH);
      return {
        blockNumber: 126n,
        gasUsed: 24_000n,
        effectiveGasPrice: 2n,
        status: 'success',
      };
    });

    await publisher.publishManifest({
      manifestCid: 'bafy-manifest',
      payload: PAYLOAD,
      onBroadcast,
    });

    expect(onBroadcast).toHaveBeenCalledTimes(1);
  });

  it('journals the exact hash once when nonce-ledger recording fails after send', async () => {
    const originalLedger = getDefaultTxSubmissionLedger();
    const onBroadcast = vi.fn();
    const { publisher, sendTransaction, waitForTransactionReceipt } = makePublisher({
      blockNumber: 126n,
      gasUsed: 24_000n,
      effectiveGasPrice: 2n,
      status: 'success',
    });
    setDefaultTxSubmissionLedger({
      getTxSubmission: () => null,
      recordTxSubmission: () => {
        throw new Error('nonce ledger disk unavailable');
      },
      markTxSubmissionResolved: () => undefined,
    });

    try {
      const error = await publisher.publishManifest({
        manifestCid: 'bafy-manifest',
        payload: PAYLOAD,
        onBroadcast,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ txHash: TX_HASH });
      expect(onBroadcast).toHaveBeenCalledOnce();
      expect(onBroadcast).toHaveBeenCalledWith(TX_HASH);
      expect(sendTransaction).toHaveBeenCalledOnce();
      expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    } finally {
      setDefaultTxSubmissionLedger(originalLedger);
    }
  });

  it('reconciles confirmed, reverted, and unavailable receipts without broadcasting', async () => {
    const confirmed = makePublisher({
      blockNumber: 127n,
      gasUsed: 25_000n,
      effectiveGasPrice: 3n,
      status: 'success',
    });
    confirmed.getTransactionReceipt.mockResolvedValueOnce({
      blockNumber: 127n,
      gasUsed: 25_000n,
      effectiveGasPrice: 3n,
      status: 'success',
    });
    await expect(
      confirmed.publisher.reconcileTransaction(TX_HASH),
    ).resolves.toEqual({
      status: 'confirmed',
      txHash: TX_HASH,
      blockNumber: 127,
      gasUsed: 25_000n,
      feeWei: 75_000n,
    });
    expect(confirmed.sendTransaction).not.toHaveBeenCalled();

    const reverted = makePublisher(new Error('unused'));
    reverted.getTransactionReceipt.mockResolvedValueOnce({
      blockNumber: 128n,
      gasUsed: 26_000n,
      effectiveGasPrice: 3n,
      status: 'reverted',
    });
    await expect(
      reverted.publisher.reconcileTransaction(TX_HASH),
    ).resolves.toEqual({ status: 'reverted', txHash: TX_HASH });

    const pending = makePublisher(new Error('unused'));
    pending.getTransactionReceipt.mockRejectedValueOnce(new Error('not found'));
    await expect(
      pending.publisher.reconcileTransaction(TX_HASH),
    ).resolves.toEqual({ status: 'pending', txHash: TX_HASH });
  });
});
