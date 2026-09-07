/**
 * A `VenueBroadcaster` implementation for hosts that have no venue-base `BaseVenue` to borrow one
 * from — standalone CLI verbs (`jinn tasks submit`, `jinn solver-plugins publish|revoke|block|
 * feedback`) that run as a single one-shot process (finding E16 item 1; C2 ruling: "CLI verbs and
 * the e2e harness construct their own").
 *
 * Signs and submits a Safe `execTransaction` directly against the given `publicClient` /
 * `walletClient`, using the pre-validated (approved-hash) signature encoding — the same encoding
 * `buildSafeSignature` documents and the pre-cutover `executeSafeTransaction` used. Deliberately
 * simpler than venue-base's `createSafeBroadcaster`: no persisted nonce ledger, since a fresh
 * process always starts from the RPC's current on-chain nonce.
 *
 * D0a round-1 review: the "one Safe transaction per invocation" premise does not hold for every
 * caller — `jinn solver-plugins` builds TWO independent instances of this broadcaster for the SAME
 * agent EOA (`publisherFactory`'s publish/revoke, and the reputation write client), both
 * reachable from one process. `execute` therefore serializes through `withEoaBroadcastLock`
 * (per-EOA, in-process by default here — no host installs a shared lock for a one-shot CLI verb)
 * so two same-EOA broadcasters in one process cannot read the same pending nonce concurrently.
 * This does not add cross-process protection — that remains `cli/daemon-guard.ts`'s job, and it
 * is a point-in-time pidfile read at context construction, not a held lease: a daemon that starts
 * a moment later is unprotected (inherent TOCTOU).
 */
import type { Address, Hex, Log, PublicClient, WalletClient } from 'viem';
import { SAFE_ABI } from '../../contracts/abis.js';
import {
  flattenErrorMessage,
  SAFE_STALE_NONCE_ERROR_TOKEN,
  withEoaBroadcastLock,
  withRecoverableRetry,
} from '../../tx-retry.js';
import type { VenueBroadcaster } from './safe.js';
import {
  decodeSafeInnerRevert,
  formatDecodedRevert,
  SafeExecutionRevertedError,
  SafeInnerRevertError,
} from './safe-revert.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/**
 * The receipt this broadcaster resolves. Structurally venue-base's `SafeBroadcastReceipt`, so a
 * direct broadcaster can drive venue-base ports that read block identity or decode router events
 * out of the receipt logs -- `createVerdictPorts` does both (issue #2665: `openVerdictAttempt`
 * ran `decodeEvaluationAttemptFromLogs(receipt.logs)` over `undefined` because this broadcaster
 * awaited `waitForTransactionReceipt` and then discarded it).
 */
export interface DirectSafeBroadcastReceipt {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly logs: readonly Log[];
  /**
   * Always `false`. This broadcaster has no already-settled reconciliation path: an inner revert
   * whose effect is already on chain surfaces as a `SafeInnerRevertError` for the caller to
   * classify, which is what a one-shot CLI verb wants. Venue-base's own `createSafeBroadcaster`
   * is the broadcaster that resolves `true` here.
   */
  readonly alreadySettled: false;
}

/**
 * `VenueBroadcaster` narrowed to the receipt above. Declared as an extension so the compiler
 * proves the narrowing rather than the two shapes drifting apart silently.
 */
export interface DirectSafeBroadcaster extends VenueBroadcaster {
  execute(request: {
    readonly to: Address;
    readonly value: bigint;
    readonly data: Hex;
    readonly logicalTx: string;
    readonly operation?: 0 | 1;
  }): Promise<DirectSafeBroadcastReceipt>;
}

/** eth_sign `v` adjustment — Safe's `checkNSignatures` expects `v > 30` for a message-prefixed hash. */
function toSafeEthSignSignature(signature: Hex): Hex {
  const bytes = Buffer.from(signature.slice(2), 'hex');
  bytes[64] = bytes[64]! + 4;
  return `0x${bytes.toString('hex')}` as Hex;
}

export function createDirectSafeBroadcaster(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
): DirectSafeBroadcaster {
  return {
    safeAddress,
    async execute(request) {
      const account = walletClient.account;
      if (!account) {
        throw new Error('createDirectSafeBroadcaster: walletClient has no account');
      }
      return withEoaBroadcastLock(account.address, () => withRecoverableRetry(async () => {
        /**
         * Re-simulate the inner call as a static `eth_call` and name the revert it recovers, or
         * `null` when the inner call does not revert. Shared by the two paths that need it: the
         * GS013/GS026 wrapper thrown at submission, and a transaction that MINED with
         * `status: 'reverted'` (issue #3733).
         */
        const decodeInnerRevertError = async (txHash: Hex | null): Promise<SafeInnerRevertError | null> => {
          const inner = await decodeSafeInnerRevert(publicClient, {
            safeAddress,
            to: request.to,
            value: request.value,
            data: request.data,
          });
          if (inner.decodedName === null && inner.innerSelector === null) return null;
          const detail = inner.decodedName === null
            ? `undecoded selector ${inner.innerSelector}`
            : formatDecodedRevert(inner.decodedName, inner.decodedArgs);
          return new SafeInnerRevertError(
            `Safe execTransaction inner revert on ${request.logicalTx} for Safe ${safeAddress}:`
            + ` ${detail}`,
            inner.innerSelector,
            inner.innerData,
            inner.decodedName,
            inner.decodedArgs,
            txHash,
          );
        };

        const nonce = await publicClient.readContract({
          address: safeAddress,
          abi: SAFE_ABI,
          functionName: 'nonce',
        });
        const safeTxHash = await publicClient.readContract({
          address: safeAddress,
          abi: SAFE_ABI,
          functionName: 'getTransactionHash',
          args: [
            request.to,
            request.value,
            request.data,
            request.operation ?? 0,
            0n,
            0n,
            0n,
            ZERO_ADDRESS,
            ZERO_ADDRESS,
            nonce,
          ],
        });
        const ethSignature = await walletClient.signMessage({
          account,
          message: { raw: safeTxHash as Hex },
        });
        const safeSignature = toSafeEthSignSignature(ethSignature as Hex);

        let txHash: Hex;
        try {
          txHash = await walletClient.writeContract({
            address: safeAddress,
            abi: SAFE_ABI,
            functionName: 'execTransaction',
            args: [
              request.to,
              request.value,
              request.data,
              request.operation ?? 0,
              0n,
              0n,
              0n,
              ZERO_ADDRESS,
              ZERO_ADDRESS,
              safeSignature,
            ],
            account,
            chain: walletClient.chain,
            value: request.value,
          });
        } catch (error) {
          const message = flattenErrorMessage(error);
          if (message.includes('GS013') || message.includes('GS026')) {
            const inner = await decodeInnerRevertError(null);
            if (inner !== null) throw inner;
          }
          throw error;
        }
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        // viem resolves this receipt whatever its status, so without an explicit check a
        // top-level revert is reported as a successful broadcast with `logs: []` -- surfacing
        // downstream as venue-base's "no canonical EvaluationAttemptCreated", which names the
        // decoding miss rather than the cause, or (on the legs that decode nothing) as a
        // `settled` result pointing at a transaction that did nothing (issue #3733).
        //
        // `safeTxGas` and `gasPrice` are both 0 here, so a failing inner call reverts
        // execTransaction at the top level: re-simulating recovers the reason where there is one.
        // venue-base's `createSafeBroadcaster` treats the same receipt the same way, minus its
        // already-settled branch -- this broadcaster pins `alreadySettled: false` and hands the
        // decoded error to the caller to classify instead (see the interface docstring above).
        if (receipt.status !== 'success') {
          const inner = await decodeInnerRevertError(txHash);
          if (inner !== null) throw inner;
          // Re-simulation found no inner revert, so the inner call is fine now and the mined
          // failure was a stale Safe nonce or signature race. The retry closure re-reads the
          // nonce and re-signs on every attempt, so this self-heals -- which is why the message
          // carries SAFE_STALE_NONCE_ERROR_TOKEN, the retry policy's marker for exactly this
          // receipt path. Exhausting the budget still throws rather than reporting success.
          throw new SafeExecutionRevertedError(
            `Safe execTransaction mined with status "${receipt.status}" —`
            + ` ${SAFE_STALE_NONCE_ERROR_TOKEN}: tx ${txHash} for Safe ${safeAddress}`
            + ` (${request.logicalTx})`,
            txHash,
            safeAddress,
            request.logicalTx,
          );
        }
        return {
          txHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          logs: receipt.logs,
          alreadySettled: false,
        };
      }));
    },
  };
}
