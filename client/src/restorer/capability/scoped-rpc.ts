/**
 * Scoped RPC constructor — wraps an upstream public RPC client and
 * enforces a chain-id allow-list before delegating.
 */

import type { ScopedRpc } from './index.js';

export interface CreateScopedRpcArgs {
  /** A viem PublicClient (or compatible read-only RPC) the daemon owns. */
  upstream: ScopedRpc;
  /** Chain ids this impl is allowed to read. Empty array = none. */
  chainIdAllowList: readonly number[];
}

export function createScopedRpc({
  upstream,
  chainIdAllowList,
}: CreateScopedRpcArgs): ScopedRpc {
  async function ensureChainAllowed(): Promise<void> {
    const chainId = await upstream.getChainId();
    if (!chainIdAllowList.includes(chainId)) {
      throw new Error(
        `chain ${chainId} not in allow-list ${JSON.stringify(chainIdAllowList)}`,
      );
    }
  }

  return {
    async readContract(args) {
      await ensureChainAllowed();
      return upstream.readContract(args);
    },
    async getBlockNumber() {
      await ensureChainAllowed();
      return upstream.getBlockNumber();
    },
    async getBalance(args) {
      await ensureChainAllowed();
      return upstream.getBalance(args);
    },
    async getCode(args) {
      await ensureChainAllowed();
      return upstream.getCode(args);
    },
    async getChainId() {
      return upstream.getChainId();
    },
  };
}
