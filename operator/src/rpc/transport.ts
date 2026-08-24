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
  ExecutionRevertedError,
  fallback,
  http,
  LimitExceededRpcError,
  TransactionRejectedRpcError,
  UserRejectedRequestError,
  type FallbackTransport,
  type Transport,
} from 'viem';

/**
 * Hard cap on the number of providers in a single fallback chain. Six covers
 * the "5 vetted free defaults + 1 operator-prepended paid primary" shape: a
 * chain that ships 5 distinct free providers per supported chain (#911) and
 * still leaves one slot for an operator's paid primary to survive
 * dedup-then-cap. Beyond that the boot probe takes too long and slot 7+ is
 * almost always copy-paste noise.
 */
export const MAX_RPC_CHAIN_LENGTH = 6;

export interface ParseRpcUrlsOptions {
  /** Logger used to emit the "capped" warning. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * Normalise `string | readonly string[]` into a non-empty, deduplicated,
 * capped list of RPC URLs. Comma-separated strings are split (operator
 * convention, see `peers` in `config.ts`). Duplicates are removed before the
 * cap is applied so the effective chain length matches operator intent (an
 * operator who prepends their paid primary to the existing fallback list
 * shouldn't burn a slot on the duplicate).
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

  // Dedup before applying the cap so repeated URLs (easy to introduce when an
  // operator prepends a paid primary that already exists in the fallback list)
  // don't burn slots of the chain. `Set` preserves first-seen insertion
  // order, which matches the "primary stays in slot 0" constraint.
  const deduped = [...new Set(cleaned)];

  if (deduped.length > MAX_RPC_CHAIN_LENGTH) {
    log(
      `[rpc] capped fallback chain to ${MAX_RPC_CHAIN_LENGTH} providers ` +
        `(dropped ${deduped.length - MAX_RPC_CHAIN_LENGTH} extra slots)`,
    );
    return deduped.slice(0, MAX_RPC_CHAIN_LENGTH);
  }

  return deduped;
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
 * Detect errors that viem's `fallback()` short-circuits on (via its
 * `shouldThrow(err)` fast-exit) — `ExecutionRevertedError`,
 * `TransactionRejectedRpcError`, `UserRejectedRequestError`,
 * `WalletConnectSessionSettlementError`, and CAIP user-rejected (code
 * `5000`). These are EVM- or wallet-level signals, NOT transport-level
 * failures, so they must propagate unchanged. Wrapping them as
 * `AllRpcsFailedError` would give the operator-app a false-positive
 * "all RPCs failed" message when the actual problem is e.g. a contract
 * revert on a view function.
 *
 * Mirrors viem's own predicate at
 * `node_modules/viem/clients/transports/fallback.ts` (`shouldThrow`),
 * dispatching by **numeric JSON-RPC code** (the path that catches real
 * `RpcRequestError` instances coming out of the HTTP transport) plus the
 * `ExecutionRevertedError.nodeMessage` regex (the path that catches reverts
 * surfaced as plain `Error` with no numeric code). The cause-chain walk by
 * class `name` remains as a third path for wallet-provider stacks that
 * deliver proper class instances (and for already-normalised errors after
 * viem's `buildRequest` re-wrap pass).
 */
export function isViemShouldThrowError(err: unknown): boolean {
  // 1. Code-based dispatch — matches what viem's own `shouldThrow` does,
  //    so a raw `RpcRequestError { code: 3 | -32003 | 4001 | 7000 | 5000 }`
  //    from the HTTP transport is caught here regardless of class name.
  //    Codes are pulled from the viem error classes (no magic numbers) where
  //    available; 7000 and 5000 are inline because
  //    `WalletConnectSessionSettlementError` is not re-exported from the
  //    top-level `viem` package and 5000 is the CAIP user-rejected code
  //    viem hard-codes alongside it.
  if (err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'number') {
    const code = (err as { code: number }).code;
    if (
      code === ExecutionRevertedError.code ||      // 3 — contract revert
      code === TransactionRejectedRpcError.code || // -32003 — tx rejected
      code === UserRejectedRequestError.code ||    // 4001 — user-rejected
      code === 7000 ||                             // WalletConnectSessionSettlementError
      code === 5000                                // CAIP user-rejected
    ) return true;
    // 2. nodeMessage regex — catches reverts that arrive as a plain `Error`
    //    (no numeric code, no recognised class name). Viem's own
    //    `shouldThrow` runs this check too.
    if (ExecutionRevertedError.nodeMessage.test(err.message)) return true;
  }
  // 3. Cause-chain walk — viem wraps low-level RPC errors in higher-level
  //    error classes (e.g. `ContractFunctionExecutionError` →
  //    `RpcRequestError` → `ExecutionRevertedError`), and wallet providers
  //    can deliver proper class instances directly. Walk with cycle
  //    detection so a self-referential `.cause` cannot infinite-loop.
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

/**
 * Default cooldown applied to a slot that returns a quota / rate-limit error
 * (#835). After this window the demoted slot becomes eligible again rather than
 * being permanently disabled (AC2), so a transient 429 / monthly-quota blip
 * never strands an operator on a degraded provider for the rest of the process.
 */
export const DEFAULT_RPC_COOLDOWN_MS = 60_000;

/**
 * Detect quota / rate-limit errors from an RPC provider (#835). Unlike
 * {@link isViemShouldThrowError} (which marks EVM/wallet-level signals that must
 * NOT trigger fallback), a quota error means the *slot* is temporarily unusable
 * and should be demoted behind healthy slots for a cooldown window. Walks the
 * cause chain (cycle-safe, mirroring `isViemShouldThrowError`) and matches on:
 *  - HTTP `status === 429` (the `http()` transport's `HttpRequestError`);
 *  - JSON-RPC `code === LimitExceededRpcError.code` (-32005);
 *  - a narrow message regex backstop covering unambiguous provider phrasings
 *    ("rate limit", "too many requests", "429", "quota", "compute unit",
 *    "request rate", "throughput") — deliberately excluding the ambiguous
 *    "limit"/"exceeded" words that collide with gas-limit errors.
 *
 * Deliberately narrow: a 5xx / network error is NOT a quota error (it falls
 * through via viem but does not cool the slot — AC3 keeps static order when no
 * quota errors occur), and a contract revert (code 3) is never a quota error.
 */
export function isRpcQuotaError(err: unknown): boolean {
  // HTTP 429 (below) and JSON-RPC -32005 (LimitExceededRpcError) are the PRIMARY
  // detectors. This message regex is only a backstop for providers that surface
  // quota errors as plain text. It deliberately avoids the ambiguous "limit" /
  // "exceeded" words: a bare `exceeded.*limit` alternative false-positives on
  // gas errors like "exceeded block gas limit" / "gas limit exceeded", which can
  // arrive with a non-shouldThrow code (e.g. -32000) and would wrongly cool a
  // healthy slot. The phrases below are unambiguously quota/rate-limit and never
  // appear in gas/execution errors; the only thing dropped is a text-only quota
  // error carrying no 429 / -32005, which no major provider (Alchemy / Infura /
  // publicnode / Tenderly) produces.
  const quotaMessage = /rate.?limit|too many requests|429|quota|compute unit|request rate|throughput/i;
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor instanceof Error && !seen.has(cursor)) {
    seen.add(cursor);
    // Comparing against a numeric constant already excludes non-numbers, so no
    // separate `typeof === 'number'` guard is needed here.
    if ((cursor as { status?: unknown }).status === 429) return true;
    if ((cursor as { code?: unknown }).code === LimitExceededRpcError.code) return true;
    if (quotaMessage.test(cursor.message)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
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

/**
 * Redact any `http(s)://` URL embedded in an arbitrary error message down to
 * its hostname (via {@link maskRpcHost}). `maskRpcHost` itself only covers
 * the boot/preflight *log* path (its three existing call sites); this is the
 * companion used on the API-response / receipt-persistence path, where a
 * failing paid RPC (key-in-path) would otherwise leak its key through a
 * viem `HttpRequestError`-shaped message (spec §14.2 item 2, issue #2402).
 */
export function maskUrlsInMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/g, (url) => maskRpcHost(url));
}

/**
 * Shared persistence/emission sanitizer for RPC-derived error text (#642).
 * Walks `Error.cause` so nested viem HttpRequestError URLs cannot bypass
 * {@link maskUrlsInMessage}. Uses the same host-only dialect — no second
 * redaction vocabulary.
 */
export function sanitizeErrorText(input: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = input;
  while (cursor !== undefined && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof Error) {
      const text = cursor.message.trim() || cursor.name;
      if (text) parts.push(maskUrlsInMessage(text));
      cursor = cursor.cause;
      continue;
    }
    parts.push(maskUrlsInMessage(String(cursor)));
    break;
  }
  return parts.join(' caused by: ');
}

export function sanitizePersistedText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return maskUrlsInMessage(value);
}

export function sanitizeStructuredValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return maskUrlsInMessage(value);
  if (value instanceof Error) return sanitizeErrorText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeStructuredValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeStructuredValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export interface BuildFallbackTransportOptions {
  /**
   * Set to `true` to let viem rank providers by latency. Default `false` —
   * order matters for operator-configured paid primaries and the
   * "Tenderly stays in slot 3" constraint from the issue.
   */
  rank?: boolean;
  /**
   * Injectable clock for the quota-cooldown bookkeeping (#835). Defaults to
   * {@link Date.now}. Tests pass a controllable stub so cooldown expiry (AC2)
   * is deterministic without real timers.
   */
  now?: () => number;
  /**
   * How long a slot stays demoted after a quota / rate-limit error, in ms
   * (#835). Defaults to {@link DEFAULT_RPC_COOLDOWN_MS}.
   */
  cooldownMs?: number;
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
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_RPC_COOLDOWN_MS;
  const rank = options.rank ?? false;

  // Cooldown bookkeeping, indexed by ORIGINAL slot index (#835). A slot that
  // returns a quota / rate-limit error is demoted behind the healthy slots
  // until `cooldownUntil[i]`, then becomes eligible again (AC1 + AC2). When no
  // quota errors occur every entry stays 0 and the configured order is
  // preserved verbatim (AC3).
  const cooldownUntil = new Array<number>(transports.length).fill(0);

  // Self-stamping slot wrappers, built ONCE over the original slot order. Each
  // wraps its original transport FACTORY, closing over its ORIGINAL index `i`.
  // When the instantiated slot's request rejects with a quota error it stamps
  // its OWN `cooldownUntil[i]` and re-throws unchanged. This per-slot
  // self-stamping is why we don't use viem's `onResponse` — its `transport`
  // arg is a freshly-instantiated instance that can't be mapped back to a slot
  // index. Only the wrapper ARRAY is reordered per request (below); the
  // wrappers themselves keep their original index for the lifetime of the
  // chain.
  const stampingTransports: Transport[] = transports.map((make, i) => {
    return ((config) => {
      const instance = make(config);
      const innerRequest = instance.request.bind(instance);
      instance.request = (async (args: { method: string; params: unknown[] }) => {
        try {
          return await innerRequest(args);
        } catch (err) {
          // A revert / user-rejected (shouldThrow-class) is an EVM/wallet
          // signal, never a transport quota problem — must NOT cool the slot.
          if (!isViemShouldThrowError(err) && isRpcQuotaError(err)) {
            cooldownUntil[i] = now() + cooldownMs;
          }
          throw err;
        }
      }) as typeof instance.request;
      return instance;
    }) as Transport;
  });

  // Per-request slot order: healthy slots (in original order) first, then
  // cooling slots (in original order) as a last resort. Strict `<` means a
  // slot is healthy again exactly at `now() === cooldownUntil[i]`.
  const orderSlots = (): Transport[] => {
    const healthy: Transport[] = [];
    const cooling: Transport[] = [];
    const t = now();
    for (let i = 0; i < stampingTransports.length; i++) {
      if (t < cooldownUntil[i]!) cooling.push(stampingTransports[i]!);
      else healthy.push(stampingTransports[i]!);
    }
    return [...healthy, ...cooling];
  };

  const wrapped: FallbackTransport = ((config) => {
    // Instantiate one inner fallback so the returned object carries the
    // canonical `FallbackTransport` shape (`type: 'fallback'`, `onResponse`,
    // `transports`). Its `request` is overridden to rebuild a fresh
    // `fallback()` over the reordered slots on every call — the reorder is the
    // whole point of #835, and a fresh chain with `retryCount: 0` reproduces
    // the existing per-slot fall-through behaviour exactly.
    const shape = fallback(stampingTransports, { rank, retryCount: 0 })(config);
    shape.request = (async (args: { method: string; params: unknown[] }) => {
      const perCall = fallback(orderSlots(), { rank, retryCount: 0 })(config);
      try {
        return await perCall.request(args as never);
      } catch (err) {
        // shouldThrow-class errors (revert, user-rejected, CAIP 5000) are
        // EVM/wallet-level — propagate unchanged so a single-slot revert is
        // never misread as an exhausted-chain outage.
        if (isViemShouldThrowError(err)) throw err;
        // The whole chain is exhausted. viem has no distinct "all transports
        // failed" class, so wrap the last underlying error in our structured
        // `AllRpcsFailedError` carrying the masked host list in ORIGINAL
        // configured order (never reordered).
        throw new AllRpcsFailedError(maskedProviders, err);
      }
    }) as typeof shape.request;
    return shape;
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
