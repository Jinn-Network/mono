import {
  createPublicClient,
  createWalletClient,
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
  isNonceTooLowError,
  isReplacementUnderpricedError,
  type TxSubmissionLedger,
  withNonceLedger,
  withRecoverableRetry,
} from '../../tx-retry.js';
import {
  SafeInnerRevertError,
  decodeSafeInnerRevert,
  formatDecodedRevert,
} from './safe-revert.js';
import { buildFallbackTransport, parseRpcUrls } from '../../rpc/transport.js';

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

export interface SafeExecutionOptions {
  ledger?: TxSubmissionLedger;
}

// Per-Safe transaction lock to prevent nonce races when concurrent
// loops (creator + harness) share the same Safe
const safeLocks = new Map<string, Promise<void>>();

export async function executeSafeTransaction(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: SafeTransactionParams,
  options: SafeExecutionOptions = {},
): Promise<Hex> {
  const lockKey = params.safeAddress.toLowerCase();

  // Wait for any pending transaction on this Safe to complete
  const pending = safeLocks.get(lockKey) ?? Promise.resolve();

  let releaseLock!: () => void;
  const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
  safeLocks.set(lockKey, newLock);

  await pending;

  try {
    const hash = await executeSafeTransactionInner(publicClient, walletClient, params, options);
    return hash;
  } finally {
    releaseLock();
  }
}

async function executeSafeTransactionInner(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: SafeTransactionParams,
  options: SafeExecutionOptions,
): Promise<Hex> {
  const { safeAddress, to, value, data } = params;
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');
  const from = account.address;

  return withNonceLedger({
    publicClient,
    walletClient,
    ledger: options.ledger,
    from,
    recoverStuckNonce: true,
  }, async (nonceLedger) => withRecoverableRetry(
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

      const feeResult = await nonceLedger.feeResultForAttempt(attemptIndex, {
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
          nonce: nonceLedger.nonce,
          ...feeResult.overrides,
        });
      } catch (writeErr) {
        const nonceTooLow = isNonceTooLowError(writeErr);
        const replacementUnderpriced = isReplacementUnderpricedError(writeErr);

        // Issue #897: before re-signing at a fresh nonce, reconcile against the
        // tx already submitted at the currently-pinned nonce. The original EOA
        // tx may have mined mid-retry (nonce-too-low = it mined; replacement-
        // underpriced = it is still pending but the bump was too small and it
        // may mine before the next attempt). Re-signing a NEW Safe
        // execTransaction at the advanced Safe nonce is NOT idempotent — it
        // re-attempts the delivery and reverts as already-claimed. So if the
        // original receipt is already a success, short-circuit and return it;
        // otherwise refresh the pinned nonce so the next attempt bumps fees
        // against the fresh value and detects a mid-retry mine on the following
        // pass.
        if (nonceTooLow || replacementUnderpriced) {
          // The ledger lookup MUST use the ORIGINAL pinned nonce
          // (nonceLedger.nonce) — read it here, before refreshNonce() below
          // advances it. Moving refreshNonce() earlier would break
          // reconciliation by looking up the wrong (advanced) nonce key.
          const existing = await nonceLedger.ledger.getTxSubmission({
            chainId: nonceLedger.chainId,
            from: nonceLedger.from,
            nonce: nonceLedger.nonce,
          });
          // The tx-submission ledger is SHARED across every logical Safe tx the
          // daemon broadcasts from this one agent EOA (claim, deliver,
          // setMetadata, reStake) and is keyed only on the EOA nonce. A
          // stuck-then-mined UNRELATED tx at the same nonce would otherwise let
          // us return a foreign tx's hash and false-mark THIS delivery as
          // landed. Gate the reconcile on the ledger entry actually being this
          // call's own transaction: recordSubmitted stores `to: safeAddress`
          // and `data: params.data`, so require both to match before trusting
          // existing.hash. On mismatch, fall through to refresh + re-sign
          // exactly as if no success receipt were found. (`to`/safeAddress are
          // addresses — compare case-insensitively; data is calldata hex —
          // normalize both to be safe.)
          const entryMatchesThisTx =
            existing?.to?.toLowerCase() === params.safeAddress.toLowerCase() &&
            existing?.data?.toLowerCase() === params.data.toLowerCase();
          if (existing?.hash && entryMatchesThisTx) {
            try {
              const reconciled = await publicClient.getTransactionReceipt({ hash: existing.hash });
              if (reconciled.status === 'success') {
                console.error(
                  `[safe/viem] execTransaction reconciled: original tx ${existing.hash} mined ` +
                    `at pinned nonce ${nonceLedger.nonce} — delivery already landed`,
                );
                await nonceLedger.markResolved();
                return existing.hash;
              }
            } catch (receiptErr) {
              // TransactionReceiptNotFoundError: the original is not yet mined.
              // Any other failure (transient RPC fault) is also tolerated —
              // we fall through to refresh + re-sign rather than rethrow — but
              // log it so a persistent fault is observable, not masked.
              const reason = receiptErr instanceof Error ? receiptErr.message : String(receiptErr);
              console.error(
                `[safe/viem] execTransaction reconcile receipt lookup for ${existing.hash} ` +
                  `failed (${reason}) — treating as not-yet-mined, refreshing nonce`,
              );
            }
          }

          const refreshed = await nonceLedger.refreshNonce();
          console.error(`[safe/viem] execTransaction refreshed pinned nonce -> ${refreshed}`);
        }
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
          if (inner.innerSelector) {
            // Deterministic inner revert with an undecoded selector — terminal.
            // Surface it structurally so tx-retry does not retry the GS013.
            throw new SafeInnerRevertError(
              `Safe execTransaction inner revert (estimate, undecoded selector ${inner.innerSelector})`,
              inner.innerSelector,
              inner.innerData,
              null,
              null,
              null,
            );
          }
          if (msg.includes('GS026')) {
            throw new Error(
              'Safe execTransaction rejected (GS026: invalid owner — signing key is not a Safe owner). ' +
                'Repair the Safe owner set or repoint the agent signing key to a current owner.',
            );
          }
        }
        throw writeErr;
      }
      await nonceLedger.recordSubmitted({
        hash,
        logicalTx: 'safe.execTransaction',
        fees: feeResult.snapshot,
        to: safeAddress,
        value: params.value,
        data,
      });
      // Wait inside the retry attempt so reverted Safe executions caused by
      // stale nonce / signature races re-read nonce and re-sign.
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
        if (inner.innerSelector) {
          // The inner call reverts deterministically with a selector we don't
          // decode (e.g. a newer custom error like TACTaskAlreadyCredited).
          // Surface it as a SafeInnerRevertError — even without a decoded name —
          // so tx-retry classifies it non-recoverable instead of retrying the
          // wrapping GS013 forever. Re-running the same inner call reverts
          // identically.
          throw new SafeInnerRevertError(
            `Safe execTransaction inner revert (undecoded selector ${inner.innerSelector}, txHash=${hash})`,
            inner.innerSelector,
            inner.innerData,
            null,
            null,
            hash as Hex,
          );
        }
        // No inner revert on re-simulation: likely a stale Safe nonce or
        // signature race — retryable, self-heals on re-sign. Do not embed
        // GS026/GS013 in the message: bare GS026 is terminal (invalid owner)
        // and bare GS013 is terminal (inner revert). Issue #1986.
        throw new Error(
          `Safe execTransaction reverted (possible stale Safe nonce or signature race, txHash=${hash})`,
        );
      }
      await nonceLedger.markResolved();
      return hash;
    },
    {
      onRetry: ({ attempt, message }) => {
        console.error(`[safe/viem] execTransaction retry ${attempt}: ${message}`);
      },
    },
  ));
}

export function createClients(
  rpcUrl: string | readonly string[],
  privateKey: Hex,
  chain?: Chain,
): { publicClient: PublicClient; walletClient: WalletClient; account: ReturnType<typeof privateKeyToAccount> } {
  const account = privateKeyToAccount(privateKey);
  const selectedChain = chain ?? base;
  const transport = buildFallbackTransport(parseRpcUrls(rpcUrl));

  const publicClient = createPublicClient({
    chain: selectedChain,
    transport,
  });

  const walletClient = createWalletClient({
    account,
    chain: selectedChain,
    transport,
  });

  return { publicClient: publicClient as unknown as PublicClient, walletClient: walletClient as unknown as WalletClient, account };
}
