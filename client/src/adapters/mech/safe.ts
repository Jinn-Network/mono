import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { SAFE_ABI } from './types.js';
import {
  getDefaultTxSubmissionLedger,
  recoverStuckNonceIfNeeded,
  withRecoverableRetry,
  viemFeeOverridesForAttempt,
} from '../../tx-retry.js';
import {
  SafeInnerRevertError,
  decodeSafeInnerRevert,
  formatDecodedRevert,
} from './safe-revert.js';

export function buildSafeSignature(signerAddress: string): Hex {
  const r = signerAddress.toLowerCase().replace('0x', '').padStart(64, '0');
  const s = '0'.repeat(64);
  const v = '01';
  return `0x${r}${s}${v}` as Hex;
}

export interface SafeTransactionParams {
  safeAddress: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

// Per-Safe transaction lock to prevent nonce races when concurrent
// loops (creator + harness) share the same Safe
const safeLocks = new Map<string, Promise<void>>();

export async function executeSafeTransaction(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: SafeTransactionParams,
): Promise<Hex> {
  const lockKey = params.safeAddress.toLowerCase();

  // Wait for any pending transaction on this Safe to complete
  const pending = safeLocks.get(lockKey) ?? Promise.resolve();

  let releaseLock!: () => void;
  const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
  safeLocks.set(lockKey, newLock);

  await pending;

  try {
    const hash = await executeSafeTransactionInner(publicClient, walletClient, params);
    return hash;
  } finally {
    releaseLock();
  }
}

async function executeSafeTransactionInner(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: SafeTransactionParams,
): Promise<Hex> {
  const { safeAddress, to, value, data } = params;
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');
  const chainId = Number(await publicClient.getChainId());
  const from = account.address;
  const ledger = getDefaultTxSubmissionLedger();
  await recoverStuckNonceIfNeeded({
    publicClient,
    walletClient: walletClient as unknown as { account?: unknown; sendTransaction: (tx: any) => Promise<Hex> },
    ledger,
    from,
  });
  const eoaNonce = Number(await publicClient.getTransactionCount({
    address: from,
    blockTag: 'pending',
  }));

  return withRecoverableRetry(
    async (attemptIndex) => {
      const nonce = await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: 'nonce',
      });

      const txHash = await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: 'getTransactionHash',
        args: [
          to,
          value,
          data,
          0,
          0n,
          0n,
          0n,
          '0x0000000000000000000000000000000000000000' as Address,
          '0x0000000000000000000000000000000000000000' as Address,
          nonce,
        ],
      });

      const ethSignature = await walletClient.signMessage({
        account,
        message: { raw: txHash as Hex },
      });

      const sigBytes = Buffer.from((ethSignature as string).slice(2), 'hex');
      sigBytes[64] = sigBytes[64] + 4;
      const safeSignature = `0x${sigBytes.toString('hex')}` as Hex;

      const previous = await ledger.getTxSubmission({ chainId, from, nonce: eoaNonce });
      const feeOverrides = await viemFeeOverridesForAttempt(publicClient, attemptIndex, {
        previousFees: previous?.resolvedAtMs == null ? previous?.fees : undefined,
        forceEstimate: true,
      });

      let hash: Hex;
      try {
        hash = await walletClient.writeContract({
          address: safeAddress,
          abi: SAFE_ABI,
          functionName: 'execTransaction',
          args: [
            to,
            value,
            data,
            0,
            0n,
            0n,
            0n,
            '0x0000000000000000000000000000000000000000' as Address,
            '0x0000000000000000000000000000000000000000' as Address,
            safeSignature,
          ],
          account,
          chain: walletClient.chain,
          value: params.value,
          nonce: eoaNonce,
          ...feeOverrides,
        });
      } catch (writeErr) {
        // viem pre-flight gas estimation may revert with GS013 when the inner
        // call would fail. Decode the inner reason so callers (and tx-retry)
        // can distinguish self-already-claimed from lost-race from transient.
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        if (msg.includes('GS013') || msg.includes('GS026')) {
          const inner = await decodeSafeInnerRevert(publicClient, params);
          if (inner.decodedName) {
            const formatted = formatDecodedRevert(inner.decodedName, inner.decodedArgs);
            throw new SafeInnerRevertError(
              `Safe execTransaction inner revert (estimate): ${formatted}`,
              inner.innerSelector,
              inner.innerData,
              inner.decodedName,
              inner.decodedArgs,
              null,
            );
          }
        }
        throw writeErr;
      }
      await ledger.recordTxSubmission({
        chainId,
        from,
        nonce: eoaNonce,
        hash,
        logicalTx: 'safe.execTransaction',
        submittedAtMs: Date.now(),
        fees: feeOverrides,
        to: safeAddress,
        value: params.value,
        data,
      });
      // Wait inside the retry attempt so reverted Safe executions caused by
      // stale nonce signatures (GS026/GS013) re-read nonce and re-sign.
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        // Safe v1.3 wraps inner reverts as GS013 — re-simulate to recover
        // the actual selector + args for diagnostics and to let tx-retry
        // mark known-permanent inner errors as non-recoverable.
        const inner = await decodeSafeInnerRevert(publicClient, params);
        if (inner.decodedName) {
          const formatted = formatDecodedRevert(inner.decodedName, inner.decodedArgs);
          throw new SafeInnerRevertError(
            `Safe execTransaction inner revert: ${formatted} (txHash=${hash})`,
            inner.innerSelector,
            inner.innerData,
            inner.decodedName,
            inner.decodedArgs,
            hash as Hex,
          );
        }
        throw new Error(`Safe execTransaction reverted (GS026/GS013 possible stale nonce, txHash=${hash})`);
      }
      await ledger.markTxSubmissionResolved({
        chainId,
        from,
        nonce: eoaNonce,
        resolvedAtMs: Date.now(),
      });
      return hash;
    },
    {
      onRetry: ({ attempt, message }) => {
        console.error(`[safe/viem] execTransaction retry ${attempt}: ${message}`);
      },
    },
  );
}

export function createClients(rpcUrl: string, privateKey: Hex, chain?: Chain): { publicClient: PublicClient; walletClient: WalletClient; account: ReturnType<typeof privateKeyToAccount> } {
  const account = privateKeyToAccount(privateKey);
  const selectedChain = chain ?? base;

  const publicClient = createPublicClient({
    chain: selectedChain,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: selectedChain,
    transport: http(rpcUrl),
  });

  return { publicClient: publicClient as unknown as PublicClient, walletClient: walletClient as unknown as WalletClient, account };
}
