/**
 * Unit tests for the RPC transport helper — viem `fallback()` wrapping with
 * input normalisation (string OR array OR comma-separated env) and structured
 * `AllRpcsFailedError`. See operator/src/rpc/transport.ts.
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
  maskUrlsInMessage,
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

  it('caps the chain at 6 providers (5 vetted free defaults + 1 operator paid primary, #911)', () => {
    expect(MAX_RPC_CHAIN_LENGTH).toBe(6);
  });

  it('keeps a 5-element distinct chain un-truncated (#911)', () => {
    const five = [
      'https://r0.example',
      'https://r1.example',
      'https://r2.example',
      'https://r3.example',
      'https://r4.example',
    ];
    expect(parseRpcUrls(five)).toHaveLength(5);
    expect(parseRpcUrls(five)).toEqual(five);
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
    // 'a' repeated 3× + 6 distinct hosts → dedup yields 7 distinct → cap to 6.
    const result = parseRpcUrls(
      ['https://a.example', 'https://a.example', 'https://a.example',
        'https://b.example', 'https://c.example', 'https://d.example',
        'https://e.example', 'https://f.example', 'https://g.example'],
      { log },
    );
    expect(result).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
      'https://e.example',
      'https://f.example',
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

  // Regression (#835 M1): the message backstop must not match gas-limit /
  // execution errors. These say "limit" / "exceeded" but are NOT quota errors;
  // a healthy slot must stay healthy.
  it('is FALSE for "execution reverted: exceeded block gas limit"', () => {
    expect(isRpcQuotaError(new Error('execution reverted: exceeded block gas limit'))).toBe(false);
  });

  it('is FALSE for "gas limit exceeded"', () => {
    expect(isRpcQuotaError(new Error('gas limit exceeded'))).toBe(false);
  });

  it('is FALSE for "gas required exceeds allowance"', () => {
    expect(isRpcQuotaError(new Error('gas required exceeds allowance (10000000)'))).toBe(false);
  });

  it('is FALSE for a gas error carrying a non-shouldThrow code (-32000)', () => {
    const gas = new RpcRequestError({
      body: { method: 'eth_call', params: [] },
      error: { code: -32000, message: 'exceeded block gas limit' },
      url: 'https://a.example',
    });
    expect(isRpcQuotaError(gas)).toBe(false);
  });

  // Real provider quota phrasings the narrow backstop still catches.
  it('is TRUE for the Alchemy CUPS message', () => {
    expect(isRpcQuotaError(new Error('exceeded its compute units per second capacity'))).toBe(true);
  });

  it('is TRUE for the Infura "request rate exceeded" message', () => {
    expect(isRpcQuotaError(new Error('project ID request rate exceeded'))).toBe(true);
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

  it('a revert (code 3) on the primary never cools it — next call still tries primary first', async () => {
    // A contract revert is a shouldThrow-class error: it short-circuits past the
    // secondary AND must NOT cool the primary. So the next request still places
    // the primary in slot 0.
    const calls: string[] = [];
    const primary = vi.fn(async ({ method }: { method: string }) => {
      calls.push('primary');
      if (clock === 0) {
        throw new RpcRequestError({
          body: { method, params: [] },
          error: { code: 3, message: 'execution reverted' },
          url: 'https://a.example',
        });
      }
      if (method === 'eth_blockNumber') return '0xcc';
      return null;
    });
    const secondary = vi.fn(async () => {
      calls.push('secondary');
      throw new Error('secondary must not be consulted after a revert');
    });

    let clock = 0;
    const transport = buildFallbackTransportFromMocks(
      [primary, secondary],
      ['https://a.example', 'https://b.example'],
      { now: () => clock, cooldownMs: 60_000 },
    );
    const client = createPublicClient({ chain: mainnet, transport });

    // t=0 — revert short-circuits past the secondary, not wrapped as AllRpcsFailedError.
    let caught: unknown;
    try {
      await client.getBlockNumber({ cacheTime: 0 });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AllRpcsFailedError);
    expect(secondary).not.toHaveBeenCalled();

    // Next call, still inside any hypothetical cooldown window — primary was
    // NOT cooled, so it is tried first again and now serves.
    clock = 10_000;
    calls.length = 0;
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    expect(calls).toEqual(['primary']);
    expect(blockNumber).toBe(0xccn);
  });

  it('all slots cooling stays a last resort — both 429 then secondary recovers', async () => {
    // Request #1: both slots 429 → AllRpcsFailedError AND both cooled.
    // Request #2 (inside cooldown): with every slot cooling, the chain still
    // attempts BOTH in original order as a last resort; the secondary recovers.
    const calls: string[] = [];
    const primary = vi.fn(async ({ method }: { method: string }) => {
      calls.push('primary');
      throw new HttpRequestError({
        body: { method, params: [] },
        details: 'Too Many Requests',
        status: 429,
        url: 'https://a.example',
      });
    });
    const secondary = vi.fn(async ({ method }: { method: string }) => {
      calls.push('secondary');
      if (clock === 0) {
        throw new HttpRequestError({
          body: { method, params: [] },
          details: 'Too Many Requests',
          status: 429,
          url: 'https://b.example',
        });
      }
      if (method === 'eth_blockNumber') return '0xee';
      return null;
    });

    let clock = 0;
    const transport = buildFallbackTransportFromMocks(
      [primary, secondary],
      ['https://a.example', 'https://b.example'],
      { now: () => clock, cooldownMs: 60_000 },
    );
    const client = createPublicClient({ chain: mainnet, transport });

    // Request #1 — both 429, chain exhausted.
    let caught: unknown;
    try {
      await client.getBlockNumber({ cacheTime: 0 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AllRpcsFailedError);
    expect(calls).toEqual(['primary', 'secondary']);

    // Request #2 — both still cooling (t=30_000 < 60_000), but with every slot
    // cooling the chain attempts BOTH in original order as a last resort.
    clock = 30_000;
    calls.length = 0;
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    expect(calls).toEqual(['primary', 'secondary']);
    expect(blockNumber).toBe(0xeen);
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

// Regression coverage for spec §14.2 item 2 / issue #2402: `maskRpcHost` was
// only ever called from the boot/preflight log path — the API-response and
// SQLite-cache paths stringified caught errors raw, so a viem
// `HttpRequestError` (which embeds the full request URL, key-in-path and
// all) could leak an operator's paid-RPC secret through an unauthenticated
// endpoint. `maskUrlsInMessage` is the companion masking helper that closes
// that gap.
describe('maskUrlsInMessage', () => {
  it('masks a key-bearing URL embedded in a viem HttpRequestError message down to its hostname', () => {
    const error = new HttpRequestError({
      url: 'https://base-mainnet.g.alchemy.com/v2/SECRETKEY123',
      body: { method: 'eth_blockNumber' },
      details: 'fetch failed',
    });

    const masked = maskUrlsInMessage(error.message);

    expect(masked).toContain('base-mainnet.g.alchemy.com');
    expect(masked).not.toContain('SECRETKEY123');
    expect(masked).not.toContain('https://base-mainnet.g.alchemy.com/v2/SECRETKEY123');
  });

  it('masks every URL when a message embeds more than one', () => {
    const masked = maskUrlsInMessage(
      'primary https://a.example/key/AAA failed, secondary https://b.example/key/BBB also failed',
    );
    expect(masked).toBe('primary a.example failed, secondary b.example also failed');
  });

  it('leaves a message with no URL untouched', () => {
    expect(maskUrlsInMessage('connect ECONNREFUSED 127.0.0.1:0')).toBe(
      'connect ECONNREFUSED 127.0.0.1:0',
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
