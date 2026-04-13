/**
 * Classify ethers/json-rpc read failures so bootstrap reconciliation does not
 * treat flaky RPC as "service missing on-chain".
 */

import { flattenErrorMessage } from './tx-retry.js';

/**
 * True when a static call / eth_call likely failed due to transport/RPC, not an
 * authoritative on-chain revert. In this case fleet reconcile must not clear state.
 */
export function isTransientEthReadError(error: unknown): boolean {
  const err = error as { code?: string };
  if (err?.code === 'SERVER_ERROR' || err?.code === 'TIMEOUT' || err?.code === 'NETWORK_ERROR') {
    return true;
  }

  const msg = flattenErrorMessage(error).toLowerCase();

  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return true;
  }
  if (
    msg.includes('-32603') ||
    msg.includes('internal json-rpc error') ||
    msg.includes('-32005') ||
    msg.includes('request timed out') ||
    msg.includes('timeout')
  ) {
    return true;
  }
  if (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('connection refused') ||
    msg.includes('connect timeout')
  ) {
    return true;
  }
  if (
    msg.includes('bad gateway') ||
    msg.includes('service unavailable') ||
    msg.includes('502') ||
    msg.includes('503')
  ) {
    return true;
  }

  return false;
}
