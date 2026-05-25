/**
 * Unit tests for the RPC transport helper — viem `fallback()` wrapping with
 * input normalisation (string OR array OR comma-separated env) and structured
 * `AllRpcsFailedError`. See client/src/rpc/transport.ts.
 *
 * Covers AC1 (string/array input), AC7 (boot-log summary format), AC8
 * (primary error / 429 → secondary; all fail → AllRpcsFailedError).
 */

import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, HttpRequestError } from 'viem';
import { mainnet } from 'viem/chains';
import {
  parseRpcUrls,
  buildFallbackTransport,
  describeFallbackChain,
  AllRpcsFailedError,
  MAX_RPC_CHAIN_LENGTH,
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
  return buildFallbackTransport.buildFromTransports(transports, urls);
}
