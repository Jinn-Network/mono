/**
 * Classify ethers/json-rpc read failures so bootstrap reconciliation does not
 * treat flaky RPC as "service missing on-chain".
 */

import { flattenErrorMessage, sleep } from './tx-retry.js';

/** Backoff delays between transient eth_read retries (issue #546). */
export const TRANSIENT_ETH_READ_RETRY_DELAYS_MS = [250, 500, 1000] as const;

export const TRANSIENT_ETH_READ_MAX_ATTEMPTS = 3;

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

/**
 * True when an RPC read failed specifically because the endpoint rate-limited
 * the daemon (HTTP 429 / "too many requests"). This is a strict subset of
 * `isTransientEthReadError` — it deliberately does NOT match generic timeouts
 * or 5xx errors. The shared default Base Sepolia RPC throttles the whole
 * operator pool; classifying a throttle distinctly lets the UI tell the
 * operator to add their own key rather than showing a generic outage message.
 * See jinn-mono #325.
 */
export function isRateLimitedEthReadError(error: unknown): boolean {
  const msg = flattenErrorMessage(error).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

/**
 * Retry a single eth_read RPC (getBlockNumber, getLogs, eth_call) on transient
 * transport failures. Used by the on-chain discovery floor for MetadataSet
 * scans so a single rate-limit does not degrade manifest hash verification.
 * See jinn-mono #546.
 */
export async function withTransientEthReadRetry<T>(
  fn: () => Promise<T>,
  options?: { sleepFn?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleepFn = options?.sleepFn ?? sleep;

  for (let attempt = 0; attempt < TRANSIENT_ETH_READ_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === TRANSIENT_ETH_READ_MAX_ATTEMPTS - 1;
      if (!isTransientEthReadError(err) || isLastAttempt) {
        throw err;
      }
      await sleepFn(TRANSIENT_ETH_READ_RETRY_DELAYS_MS[attempt]!);
    }
  }

  throw new Error('withTransientEthReadRetry: exhausted attempts without throwing');
}
