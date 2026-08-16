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
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { SAFE_ABI } from '../../contracts/abis.js';
import { flattenErrorMessage, withEoaBroadcastLock, withRecoverableRetry } from '../../tx-retry.js';
import type { VenueBroadcaster } from './safe.js';
import {
  decodeSafeInnerRevert,
  formatDecodedRevert,
  SafeInnerRevertError,
} from './safe-revert.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

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
): VenueBroadcaster {
  return {
    safeAddress,
    async execute(request) {
      const account = walletClient.account;
      if (!account) {
        throw new Error('createDirectSafeBroadcaster: walletClient has no account');
      }
      return withEoaBroadcastLock(account.address, () => withRecoverableRetry(async () => {
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
            const inner = await decodeSafeInnerRevert(publicClient, {
              safeAddress,
              to: request.to,
              value: request.value,
              data: request.data,
            });
            if (inner.decodedName !== null || inner.innerSelector !== null) {
              const detail = inner.decodedName === null
                ? `undecoded selector ${inner.innerSelector}`
                : formatDecodedRevert(inner.decodedName, inner.decodedArgs);
              throw new SafeInnerRevertError(
                `Safe execTransaction inner revert: ${detail}`,
                inner.innerSelector,
                inner.innerData,
                inner.decodedName,
                inner.decodedArgs,
                null,
              );
            }
          }
          throw error;
        }
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        return { txHash };
      }));
    },
  };
}
