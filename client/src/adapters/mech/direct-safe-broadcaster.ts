/**
 * A `VenueBroadcaster` implementation for hosts that have no venue-base `BaseVenue` to borrow one
 * from — standalone CLI verbs (`jinn tasks submit`, `jinn solver-plugins publish|revoke|block|
 * feedback`) that run as a single one-shot process (finding E16 item 1; C2 ruling: "CLI verbs and
 * the e2e harness construct their own").
 *
 * Signs and submits a Safe `execTransaction` directly against the given `publicClient` /
 * `walletClient`, using the pre-validated (approved-hash) signature encoding — the same encoding
 * `buildSafeSignature` documents and the pre-cutover `executeSafeTransaction` used. Deliberately
 * simpler than venue-base's `createSafeBroadcaster`: a CLI verb submits exactly one Safe
 * transaction per invocation, so it needs neither a persisted nonce ledger nor a cross-process
 * broadcast lock — `withRecoverableRetry` alone absorbs transient RPC faults.
 */
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { SAFE_ABI } from '../../contracts/abis.js';
import { withRecoverableRetry } from '../../tx-retry.js';
import type { VenueBroadcaster } from './safe.js';

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
      return withRecoverableRetry(async () => {
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

        const txHash = await walletClient.writeContract({
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
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        return { txHash };
      });
    },
  };
}
