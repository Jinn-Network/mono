/**
 * Unit tests for the RPC transport helper — viem `fallback()` wrapping with
 * input normalisation (string OR array OR comma-separated env) and structured
 * `AllRpcsFailedError`. See client/src/rpc/transport.ts.
 *
 * Covers AC1 (string/array input), AC7 (boot-log summary format), AC8
 * (primary error / 429 → secondary; all fail → AllRpcsFailedError).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createPublicClient,
  custom,
  ExecutionRevertedError,
  HttpRequestError,
  LimitExceededRpcError,
  RpcRequestError,
} from 'viem';
import { mainnet } from 'viem/chains';
import {
  parseRpcUrls,
  buildFallbackTransport,
  describeFallbackChain,
  AllRpcsFailedError,
  MAX_RPC_CHAIN_LENGTH,
  isRpcQuotaError,
  DEFAULT_RPC_COOLDOWN_MS,
} from '../../src/rpc/transport.js';

describe('parseRpcUrls', () => {
  it('wraps a single string into a one-element array', () => {
    expect(parseRpcUrls('https://a.example')).toEqual(['https://a.example']);
  });

  it('splits comma-separated strings, trims, drops empties', () => {
    expect(parseRpcUrls('https://a.example, https://b.example ,')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('returns an array input unchanged (after dedup of empties)', () => {
    expect(parseRpcUrls(['https://a.example', 'https://b.example'])).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('throws on an empty array', () => {
    expect(() => parseRpcUrls([])).toThrow(/at least one RPC URL/i);
  });

  it('throws on an empty string', () => {
    expect(() => parseRpcUrls('')).toThrow(/at least one RPC URL/i);
  });

  it('throws on a comma-string that yields zero non-empty entries', () => {
    expect(() => parseRpcUrls(', ,')).toThrow(/at least one RPC URL/i);
  });

  it(`caps the chain at ${MAX_RPC_CHAIN_LENGTH} providers`, () => {
    const many = Array.from({ length: MAX_RPC_CHAIN_LENGTH + 2 }, (_, i) => `https://r${i}.example`);
    const log = vi.fn();
    const result = parseRpcUrls(many, { log });
    expect(result).toHaveLength(MAX_RPC_CHAIN_LENGTH);
    expect(result[0]).toBe('https://r0.example');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/\[rpc\] capped/);
  });

  it('deduplicates repeated URLs, preserving first-seen order', () => {
    expect(parseRpcUrls(['https://a.example', 'https://a.example', 'https://b.example'])).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('deduplicates before applying the cap so the effective chain matches operator intent', () => {
    const log = vi.fn();
    // 'a' repeated 3× + 4 distinct hosts → dedup yields 5 distinct → cap to 4.
    const result = parseRpcUrls(
      ['https://a.example', 'https://a.example', 'https://a.example',
        'https://b.example', 'https://c.example', 'https://d.example', 'https://e.example'],
      { log },
    );
    expect(result).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
    ]);
  });

  it('deduplicates entries from a comma-separated string', () => {
    expect(parseRpcUrls('https://a.example, https://a.example, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});

describe('isRpcQuotaError', () => {
  it('exposes a 60s default cooldown constant', () => {
    expect(DEFAULT_RPC_COOLDOWN_MS).toBe(60_000);
  });

  it('is TRUE for an HttpRequestError with status 429', () => {
    expect(
      isRpcQuotaError(
        new HttpRequestError({
          body: { method: 'eth_blockNumber', params: [] },
          details: 'Too Many Requests',
          status: 429,
          url: 'https://a.example',
        }),
      ),
    ).toBe(true);
  });

  it('is TRUE for a 429 nested in the cause chain', () => {
    const inner = new HttpRequestError({
      body: { method: 'eth_blockNumber', params: [] },
      details: 'Too Many Requests',
      status: 429,
      url: 'https://a.example',
    });
    const outer = Object.assign(new Error('request failed'), { cause: inner });
    expect(isRpcQuotaError(outer)).toBe(true);
  });

  it('is TRUE for an RpcRequestError carrying LimitExceededRpcError.code (-32005)', () => {
    const limit = new RpcRequestError({
      body: { method: 'eth_blockNumber', params: [] },
      error: { code: LimitExceededRpcError.code, message: 'limit exceeded' },
      url: 'https://a.example',
    });
    expect(LimitExceededRpcError.code).toBe(-32005);
    expect(isRpcQuotaError(limit)).toBe(true);
  });

  it('is TRUE for a "rate limit exceeded" message', () => {
    expect(isRpcQuotaError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('is TRUE for a "429 Too Many Requests" message', () => {
    expect(isRpcQuotaError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('is TRUE for a "monthly quota reached" message', () => {
    expect(isRpcQuotaError(new Error('monthly quota reached'))).toBe(true);
  });

  it('is FALSE for an HttpRequestError with status 503', () => {
    expect(
      isRpcQuotaError(
        new HttpRequestError({
          body: { method: 'eth_blockNumber', params: [] },
          details: 'Service Unavailable',
          status: 503,
          url: 'https://a.example',
        }),
      ),
    ).toBe(false);
  });

  it('is FALSE for an ECONNRESET network error', () => {
    expect(isRpcQuotaError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(
      false,
    );
  });

  it('is FALSE for an RpcRequestError revert (code 3)', () => {
    const reverted = new RpcRequestError({
      body: { method: 'eth_blockNumber', params: [] },
      error: { code: ExecutionRevertedError.code, message: 'execution reverted' },
      url: 'https://a.example',
    });
    expect(isRpcQuotaError(reverted)).toBe(false);
  });
});

describe('buildFallbackTransport', () => {
  it('returns a viem transport whose type is "fallback"', () => {
    const transport = buildFallbackTransport(['https://a.example']);
    const client = createPublicClient({ chain: mainnet, transport });
    expect(client.transport.type).toBe('fallback');
  });

  it('falls through to secondary when primary throws a network error', async () => {
    const primary = vi.fn(async () => {
      throw new Error('primary network unreachable');
    });
    const secondary = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_blockNumber') return '0x10';
      return null;
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });
    const blockNumber = await client.getBlockNumber();
    expect(blockNumber).toBe(0x10n);
    expect(primary).toHaveBeenCalled();
    expect(secondary).toHaveBeenCalled();
  });

  it('falls through to secondary when primary returns HTTP 429', async () => {
    const primary = vi.fn(async () => {
      // viem treats HttpRequestError 429 as retryable / fall-through-eligible.
      throw new HttpRequestError({
        body: { method: 'eth_blockNumber', params: [] },
        details: 'Too Many Requests',
        status: 429,
        url: 'https://a.example',
      });
    });
    const secondary = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_blockNumber') return '0x20';
      return null;
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });
    const blockNumber = await client.getBlockNumber();
    expect(blockNumber).toBe(0x20n);
    expect(secondary).toHaveBeenCalled();
  });

  it('rejects with AllRpcsFailedError when every provider fails', async () => {
    const primary = vi.fn(async () => {
      throw new Error('primary down');
    });
    const secondary = vi.fn(async () => {
      throw new Error('secondary down');
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    let caught: unknown;
    try {
      await client.getBlockNumber();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AllRpcsFailedError);
    if (caught instanceof AllRpcsFailedError) {
      expect(caught.providers).toEqual(['a.example', 'b.example']);
    }
  });

  it('re-throws viem ExecutionRevertedError without wrapping in AllRpcsFailedError', async () => {
    // viem's fallback() short-circuits on shouldThrow-class errors (contract
    // revert, user-rejected, etc.) — those are EVM/wallet-level, not
    // transport-level failures. Wrapping them as AllRpcsFailedError would
    // give the operator-app a false "all RPCs failed" signal.
    const reverted = Object.assign(new Error('execution reverted: bad'), {
      name: 'ExecutionRevertedError',
      code: 3, // viem's ExecutionRevertedError.code
    });
    const primary = vi.fn(async () => {
      throw reverted;
    });
    const secondary = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    let caught: unknown;
    try {
      await client.getBlockNumber();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AllRpcsFailedError);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('re-throws CAIP user-rejected (code 5000) without wrapping in AllRpcsFailedError', async () => {
    const caip = Object.assign(new Error('user rejected'), {
      name: 'CAIPUserRejectedError',
      code: 5000,
    });
    const primary = vi.fn(async () => {
      throw caip;
    });
    const secondary = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    let caught: unknown;
    try {
      await client.getBlockNumber();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AllRpcsFailedError);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('re-throws a real viem RpcRequestError (code 3) without wrapping', async () => {
    // Production path: viem's HTTP transport throws RpcRequestError for every
    // JSON-RPC error response, with `name: 'RpcRequestError'` and `code` set
    // from the JSON-RPC error. A real revert arrives as code 3, NOT named
    // 'ExecutionRevertedError', so the name-only check from round-1 missed it.
    const reverted = new RpcRequestError({
      body: { method: 'eth_blockNumber', params: [] },
      error: { code: 3, message: 'execution reverted' },
      url: 'https://a.example',
    });
    const primary = vi.fn(async () => {
      throw reverted;
    });
    const secondary = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    let caught: unknown;
    try {
      await client.getBlockNumber();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AllRpcsFailedError);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('re-throws TransactionRejectedRpcError numeric code (-32003) without wrapping', async () => {
    const rejected = new RpcRequestError({
      body: { method: 'eth_sendRawTransaction', params: [] },
      error: { code: -32003, message: 'transaction rejected' },
      url: 'https://a.example',
    });
    const primary = vi.fn(async () => {
      throw rejected;
    });
    const secondary = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    let caught: unknown;
    try {
      await client.getBlockNumber();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AllRpcsFailedError);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('re-throws UserRejectedRequestError numeric code (4001) without wrapping', async () => {
    const rejected = new RpcRequestError({
      body: { method: 'eth_sendTransaction', params: [] },
      error: { code: 4001, message: 'user rejected the request' },
      url: 'https://a.example',
    });
    const primary = vi.fn(async () => {
      throw rejected;
    });
    const secondary = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    let caught: unknown;
    try {
      await client.getBlockNumber();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AllRpcsFailedError);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('re-throws via ExecutionRevertedError.nodeMessage regex match without wrapping', async () => {
    // Some node-emitted errors arrive without the viem error class name and
    // without a numeric code — only the message text identifies them as a
    // revert. viem's own shouldThrow predicate uses
    // ExecutionRevertedError.nodeMessage to match these; our helper must too.
    const reverted = Object.assign(new Error('execution reverted: insufficient balance'), {
      name: 'Error',
    });
    const primary = vi.fn(async () => {
      throw reverted;
    });
    const secondary = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    let caught: unknown;
    try {
      await client.getBlockNumber();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AllRpcsFailedError);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('preserves slot order — primary is always slot 0', async () => {
    // Order matters for the "Tenderly stays in slot 3" constraint. The
    // helper sets rank: false explicitly.
    const calls: string[] = [];
    const primary = vi.fn(async () => {
      calls.push('primary');
      throw new Error('primary down');
    });
    const secondary = vi.fn(async () => {
      calls.push('secondary');
      return '0x1';
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://a.example',
      'https://b.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });
    await client.getBlockNumber();
    expect(calls[0]).toBe('primary');
    expect(calls[1]).toBe('secondary');
  });

  it('AC1: after a 429 on primary, the next request routes to the healthy secondary first', async () => {
    // Request #1: primary 429s → secondary serves. The 429 demotes the primary
    // for the cooldown window. Request #2 (still inside cooldown) must hit the
    // secondary FIRST and not re-call the cooled primary at all.
    const calls: string[] = [];
    const primary = vi.fn(async () => {
      calls.push('primary');
      throw new HttpRequestError({
        body: { method: 'eth_blockNumber', params: [] },
        details: 'Too Many Requests',
        status: 429,
        url: 'https://a.example',
      });
    });
    const secondary = vi.fn(async ({ method }: { method: string }) => {
      calls.push('secondary');
      if (method === 'eth_blockNumber') return '0x10';
      return null;
    });

    let clock = 0;
    const transport = buildFallbackTransportFromMocks(
      [primary, secondary],
      ['https://a.example', 'https://b.example'],
      { now: () => clock, cooldownMs: 60_000 },
    );
    const client = createPublicClient({ chain: mainnet, transport });

    await client.getBlockNumber({ cacheTime: 0 });
    expect(calls).toEqual(['primary', 'secondary']);

    // Advance time but stay well inside the cooldown.
    clock = 30_000;
    calls.length = 0;
    primary.mockClear();
    await client.getBlockNumber({ cacheTime: 0 });
    expect(calls).toEqual(['secondary']);
    expect(primary).not.toHaveBeenCalled();
  });

  it('AC2: after the cooldown expires, the demoted slot is tried first again', async () => {
    // t=0: primary 429s → secondary serves; primary cooled until t=60_000.
    // t=30_000: still cooling → secondary tried first, primary not re-called.
    // t=60_001: cooldown elapsed (strict <) → primary healthy and tried FIRST.
    const calls: string[] = [];
    const primary = vi.fn(async ({ method }: { method: string }) => {
      calls.push('primary');
      if (clock < 60_000) {
        throw new HttpRequestError({
          body: { method, params: [] },
          details: 'Too Many Requests',
          status: 429,
          url: 'https://a.example',
        });
      }
      if (method === 'eth_blockNumber') return '0xaa';
      return null;
    });
    const secondary = vi.fn(async ({ method }: { method: string }) => {
      calls.push('secondary');
      if (method === 'eth_blockNumber') return '0xbb';
      return null;
    });

    let clock = 0;
    const transport = buildFallbackTransportFromMocks(
      [primary, secondary],
      ['https://a.example', 'https://b.example'],
      { now: () => clock, cooldownMs: 60_000 },
    );
    const client = createPublicClient({ chain: mainnet, transport });

    // t=0 — primary 429 demotes it.
    await client.getBlockNumber({ cacheTime: 0 });
    expect(calls).toEqual(['primary', 'secondary']);

    // t=30_000 — still inside cooldown, secondary-first, primary skipped.
    clock = 30_000;
    calls.length = 0;
    await client.getBlockNumber({ cacheTime: 0 });
    expect(calls).toEqual(['secondary']);

    // t=60_001 — cooldown elapsed, primary restored to slot 0 and serves.
    clock = 60_001;
    calls.length = 0;
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    expect(calls).toEqual(['primary']);
    expect(blockNumber).toBe(0xaan);
  });

  it('AC3: no quota errors → static fallback order is unchanged across calls', async () => {
    // Identity permutation: when only non-quota (network) errors occur, the
    // chain walks the slots in the exact configured order p → s → t on every
    // request, and the SAME order again on the next request. A network error
    // must NOT cool a slot, so nothing gets demoted between calls.
    const calls: string[] = [];
    const primary = vi.fn(async () => {
      calls.push('p');
      throw new Error('primary network unreachable');
    });
    const secondary = vi.fn(async () => {
      calls.push('s');
      throw new Error('secondary network unreachable');
    });
    const tertiary = vi.fn(async ({ method }: { method: string }) => {
      calls.push('t');
      if (method === 'eth_blockNumber') return '0x1';
      return null;
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary, tertiary], [
      'https://p.example',
      'https://s.example',
      'https://t.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });
    await client.getBlockNumber({ cacheTime: 0 });
    await client.getBlockNumber({ cacheTime: 0 });
    expect(calls).toEqual(['p', 's', 't', 'p', 's', 't']);
  });
});

describe('describeFallbackChain', () => {
  it('formats the AC7 boot-log summary line', () => {
    expect(
      describeFallbackChain(['https://a.example/path', 'https://b.example/path']),
    ).toBe('fallback chain (2 providers) — primary=a.example');
  });

  it('handles a single-provider chain', () => {
    expect(describeFallbackChain(['https://only.example'])).toBe(
      'fallback chain (1 providers) — primary=only.example',
    );
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a fallback transport from a list of mock request fns + URLs so tests
 * can drive each slot deterministically. The transport keys match the URLs,
 * so AllRpcsFailedError reports the right host list.
 */
function buildFallbackTransportFromMocks(
  requestFns: ReadonlyArray<(args: { method: string; params: unknown[] }) => Promise<unknown>>,
  urls: readonly string[],
  options: { now?: () => number; cooldownMs?: number } = {},
) {
  if (requestFns.length !== urls.length) {
    throw new Error('buildFallbackTransportFromMocks: requestFns length must match urls');
  }
  const transports = requestFns.map((fn, i) =>
    custom(
      {
        request: fn as (args: { method: string; params: unknown[] }) => Promise<unknown>,
      },
      { key: urls[i], name: urls[i] },
    ),
  );
  return buildFallbackTransport.buildFromTransports(transports, urls, options);
}
