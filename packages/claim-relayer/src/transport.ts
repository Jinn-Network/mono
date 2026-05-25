/**
 * Inline RPC transport helper for the claim relayer — mirrors
 * `client/src/rpc/transport.ts` (Jinn issue #592). Replicated here rather
 * than imported from `@jinn-network/client` because the relayer is a
 * separate package and may publish independently. A future
 * `@jinn-network/sdk` extraction can consolidate. Keep the two copies in
 * lockstep: dedup behaviour, AllRpcsFailedError wrapping, and the
 * shouldThrow exception list must match.
 */

import {
  ExecutionRevertedError,
  fallback,
  http,
  TransactionRejectedRpcError,
  UserRejectedRequestError,
  type FallbackTransport,
  type Transport,
} from 'viem';

/** Hard cap on the number of providers in a single fallback chain. */
export const MAX_RPC_CHAIN_LENGTH = 4;

export function parseRpcUrls(input: string | readonly string[]): string[] {
  const raw = typeof input === 'string' ? input.split(',') : [...input];
  const cleaned = raw.map((u) => u.trim()).filter((u) => u.length > 0);
  if (cleaned.length === 0) {
    throw new Error('parseRpcUrls: at least one RPC URL is required');
  }
  // Dedup before applying the cap so repeated URLs don't burn slots of the
  // 4-slot chain. Mirrors `client/src/rpc/transport.ts`. `Set` preserves
  // first-seen insertion order.
  const deduped = [...new Set(cleaned)];
  if (deduped.length > MAX_RPC_CHAIN_LENGTH) {
    process.stderr.write(
      `[claim-relayer] capped fallback chain to ${MAX_RPC_CHAIN_LENGTH} providers ` +
        `(dropped ${deduped.length - MAX_RPC_CHAIN_LENGTH} extra slots)\n`,
    );
    return deduped.slice(0, MAX_RPC_CHAIN_LENGTH);
  }
  return deduped;
}

export function maskRpcHost(url: string): string {
  try {
    return new URL(url).hostname || '(unknown host)';
  } catch {
    return '(invalid rpc url)';
  }
}

/**
 * Error thrown when every provider in a fallback chain has failed. Mirrors
 * `client/src/rpc/transport.ts` AllRpcsFailedError — intentional duplication
 * (avoids cross-package deps); a future SDK extraction can consolidate.
 */
export class AllRpcsFailedError extends Error {
  readonly providers: readonly string[];
  override readonly cause?: unknown;

  constructor(providers: readonly string[], cause?: unknown) {
    super(
      `All RPC providers in the fallback chain failed (providers=${providers.join(', ')})`,
    );
    this.name = 'AllRpcsFailedError';
    this.providers = providers;
    this.cause = cause;
  }
}

/**
 * Detect errors viem's `fallback()` short-circuits on (its `shouldThrow`
 * fast-exit). These are EVM/wallet-level signals from a single slot, NOT
 * transport-level failures — they must propagate unchanged so callers don't
 * see a spurious "all RPCs failed" outage signal when the real cause is a
 * contract revert or user-rejected wallet prompt.
 *
 * Mirrors `client/src/rpc/transport.ts` `isViemShouldThrowError` — dispatch
 * by numeric JSON-RPC `code` (catches raw `RpcRequestError` instances from
 * viem's HTTP transport, where `name` is `'RpcRequestError'` and the class
 * identity is hidden behind the code), the `ExecutionRevertedError.nodeMessage`
 * regex (catches reverts surfaced as plain `Error`), and a class-name
 * cause-chain walk (catches wallet-provider class instances and viem's
 * post-`buildRequest` normalised classes).
 */
export function isViemShouldThrowError(err: unknown): boolean {
  // 1. Code-based dispatch — matches viem's own `shouldThrow`. Codes are
  //    pulled from viem error classes where they're exported from the
  //    top-level package; 7000 and 5000 are inline because
  //    `WalletConnectSessionSettlementError` is not re-exported and 5000 is
  //    the CAIP user-rejected code hard-coded alongside it.
  if (err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'number') {
    const code = (err as { code: number }).code;
    if (
      code === ExecutionRevertedError.code ||      // 3 — contract revert
      code === TransactionRejectedRpcError.code || // -32003 — tx rejected
      code === UserRejectedRequestError.code ||    // 4001 — user-rejected
      code === 7000 ||                             // WalletConnectSessionSettlementError
      code === 5000                                // CAIP user-rejected
    ) return true;
    // 2. nodeMessage regex — catches reverts arriving as plain `Error`.
    if (ExecutionRevertedError.nodeMessage.test(err.message)) return true;
  }
  // 3. Cause-chain walk with cycle detection.
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor instanceof Error && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor.name === 'ExecutionRevertedError') return true;
    if (cursor.name === 'TransactionRejectedRpcError') return true;
    if (cursor.name === 'UserRejectedRequestError') return true;
    if (cursor.name === 'WalletConnectSessionSettlementError') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

export function buildFallbackTransport(urls: readonly string[]): FallbackTransport {
  const transports = urls.map((u) => http(u));
  return buildFallbackTransport.buildFromTransports(transports, urls);
}

/**
 * Internal helper exposed for tests: build a fallback transport from
 * pre-constructed viem transports (e.g. `custom()` mocks).
 */
buildFallbackTransport.buildFromTransports = function buildFromTransports(
  transports: readonly Transport[],
  urls: readonly string[],
): FallbackTransport {
  const maskedProviders = urls.map(maskRpcHost);
  const inner = fallback(transports, { rank: false, retryCount: 0 });

  const wrapped: FallbackTransport = ((config) => {
    const t = inner(config);
    const originalRequest = t.request.bind(t);
    t.request = (async (args: { method: string; params: unknown[] }) => {
      try {
        return await originalRequest(args);
      } catch (err) {
        // shouldThrow-class errors are not transport-level outages — let
        // them propagate so the operator sees the real cause.
        if (isViemShouldThrowError(err)) throw err;
        throw new AllRpcsFailedError(maskedProviders, err);
      }
    }) as typeof t.request;
    return t;
  }) as FallbackTransport;

  return wrapped;
};

/** AC7-style boot-log summary: `fallback chain (N providers) — primary=<host>`. */
export function describeFallbackChain(urls: readonly string[]): string {
  if (urls.length === 0) return 'fallback chain (0 providers)';
  return `fallback chain (${urls.length} providers) — primary=${maskRpcHost(urls[0]!)}`;
}
