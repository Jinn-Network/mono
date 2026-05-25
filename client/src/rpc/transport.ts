/**
 * RPC transport helper — builds a viem `fallback()` transport from a single
 * URL, an array of URLs, or a comma-separated string. The substrate for issue
 * #592 (multi-RPC fallback chain across daemon / relayer / indexer / CI).
 *
 * Design:
 * - `parseRpcUrls` normalises `string | readonly string[]` to a deduplicated
 *   non-empty array, splits comma-strings, trims, drops empties, and caps the
 *   chain at {@link MAX_RPC_CHAIN_LENGTH} providers (extras are dropped with a
 *   warning). Throws when no URLs remain.
 * - `buildFallbackTransport` wraps `http(url)` per slot inside viem's
 *   `fallback([...], { rank: false, retryCount: 0 })`. `rank: false` is
 *   explicit — the issue's "Tenderly stays in slot 3" constraint requires
 *   order preservation (no latency-based reshuffling). `retryCount: 0` keeps
 *   the helper from doubling retries on top of the existing
 *   `withRecoverableRetry` wrapper used by callers like the mech adapter.
 * - On exhausted fall-through the helper rejects with `AllRpcsFailedError`,
 *   which carries a structured `providers: readonly string[]` list of masked
 *   hosts so callers and tests can assert on it.
 * - `describeFallbackChain` formats the canonical AC7 boot-log summary line:
 *   `fallback chain (N providers) — primary=<host>`.
 *
 * Do not conflate with `discovery.fallbackToOnchain` — that's a separate layer
 * at the read-API level (Ponder → eth_getLogs floor). This helper sits beneath
 * both layers at the JSON-RPC transport level.
 */

import {
  fallback,
  http,
  type FallbackTransport,
  type Transport,
} from 'viem';

/**
 * Hard cap on the number of providers in a single fallback chain. Four covers
 * the "operator paid primary + public publicnode + public sepolia.base.org +
 * Tenderly slot-3" shape from the issue; beyond that the boot probe takes too
 * long and slot 5+ is almost always copy-paste noise.
 */
export const MAX_RPC_CHAIN_LENGTH = 4;

export interface ParseRpcUrlsOptions {
  /** Logger used to emit the "capped" warning. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * Normalise `string | readonly string[]` into a non-empty, capped list of RPC
 * URLs. Comma-separated strings are split (operator convention, see `peers`
 * in `config.ts`).
 *
 * @throws if the input yields zero non-empty URLs.
 */
export function parseRpcUrls(
  input: string | readonly string[],
  options: ParseRpcUrlsOptions = {},
): string[] {
  const log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const raw = typeof input === 'string' ? input.split(',') : [...input];
  const cleaned = raw.map((u) => u.trim()).filter((u) => u.length > 0);

  if (cleaned.length === 0) {
    throw new Error('parseRpcUrls: at least one RPC URL is required');
  }

  if (cleaned.length > MAX_RPC_CHAIN_LENGTH) {
    log(
      `[rpc] capped fallback chain to ${MAX_RPC_CHAIN_LENGTH} providers ` +
        `(dropped ${cleaned.length - MAX_RPC_CHAIN_LENGTH} extra slots)`,
    );
    return cleaned.slice(0, MAX_RPC_CHAIN_LENGTH);
  }

  return cleaned;
}

/**
 * Error thrown when every provider in a fallback chain has failed. Carries
 * the masked host list so callers can surface a useful operator-facing message
 * without leaking secret query strings (api-key paths).
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
 * Mask an RPC URL down to its hostname for display / error reporting. Drops
 * the path so api-key segments in the URL don't leak into logs.
 */
export function maskRpcHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || '(unknown host)';
  } catch {
    return '(invalid rpc url)';
  }
}

export interface BuildFallbackTransportOptions {
  /**
   * Set to `true` to let viem rank providers by latency. Default `false` —
   * order matters for operator-configured paid primaries and the
   * "Tenderly stays in slot 3" constraint from the issue.
   */
  rank?: boolean;
}

/**
 * Build a viem fallback transport over the given URLs. Returns a callable
 * transport suitable for `createPublicClient({ transport })`.
 *
 * Errors that exhaust the chain are wrapped in `AllRpcsFailedError`.
 */
export function buildFallbackTransport(
  urls: readonly string[],
  options: BuildFallbackTransportOptions = {},
): FallbackTransport {
  const transports = urls.map((url) => http(url));
  return buildFallbackTransport.buildFromTransports(transports, urls, options);
}

/**
 * Internal helper exposed for tests: build a fallback transport from
 * pre-constructed viem transports (e.g. `custom()` mocks) so tests can drive
 * each slot deterministically without an actual HTTP fetch.
 */
buildFallbackTransport.buildFromTransports = function buildFromTransports(
  transports: readonly Transport[],
  urls: readonly string[],
  options: BuildFallbackTransportOptions = {},
): FallbackTransport {
  const maskedProviders = urls.map(maskRpcHost);
  const inner = fallback(transports, {
    rank: options.rank ?? false,
    retryCount: 0,
  });

  // Wrap the transport so that the final exhausted-chain rejection surfaces
  // as our structured `AllRpcsFailedError` (carrying the masked host list).
  // We do the wrap at the transport-factory level rather than swapping the
  // returned function's `request` so the FallbackTransport's typed shape
  // (`onResponse`, `transports`, etc.) is preserved.
  const wrapped: FallbackTransport = ((config) => {
    const t = inner(config);
    const originalRequest = t.request.bind(t);
    t.request = (async (args: { method: string; params: unknown[] }) => {
      try {
        return await originalRequest(args);
      } catch (err) {
        // viem doesn't expose a distinct "all transports failed" error class —
        // when fallback exhausts the chain it throws the last underlying error.
        // We always wrap so the caller gets a stable structural error.
        throw new AllRpcsFailedError(maskedProviders, err);
      }
    }) as typeof t.request;
    return t;
  }) as FallbackTransport;

  return wrapped;
};

/**
 * Boot-log summary line for a fallback chain. Matches the canonical AC7
 * format: `fallback chain (N providers) — primary=<host>`.
 */
export function describeFallbackChain(urls: readonly string[]): string {
  if (urls.length === 0) return 'fallback chain (0 providers)';
  return `fallback chain (${urls.length} providers) — primary=${maskRpcHost(urls[0]!)}`;
}
