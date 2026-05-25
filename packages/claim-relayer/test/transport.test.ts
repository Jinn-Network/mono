/**
 * Unit tests for the relayer's inline RPC transport helper — mirrors
 * `client/src/rpc/transport.ts` (Jinn issue #592). Intentional duplication;
 * keep behaviour aligned across packages.
 */

import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom } from 'viem';
import { mainnet } from 'viem/chains';
import {
  AllRpcsFailedError,
  buildFallbackTransport,
  describeFallbackChain,
  MAX_RPC_CHAIN_LENGTH,
  parseRpcUrls,
} from '../src/transport.js';

describe('parseRpcUrls (relayer)', () => {
  it('wraps a single string into a one-element array', () => {
    expect(parseRpcUrls('https://a.example')).toEqual(['https://a.example']);
  });

  it('splits comma-separated strings, trims, drops empties', () => {
    expect(parseRpcUrls('https://a.example, https://b.example ,')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('throws on an empty input', () => {
    expect(() => parseRpcUrls('')).toThrow(/at least one RPC URL/i);
    expect(() => parseRpcUrls([])).toThrow(/at least one RPC URL/i);
  });

  it(`caps the chain at ${MAX_RPC_CHAIN_LENGTH} providers`, () => {
    const many = Array.from({ length: MAX_RPC_CHAIN_LENGTH + 2 }, (_, i) => `https://r${i}.example`);
    const result = parseRpcUrls(many);
    expect(result).toHaveLength(MAX_RPC_CHAIN_LENGTH);
    expect(result[0]).toBe('https://r0.example');
  });

  it('deduplicates repeated URLs, preserving first-seen order', () => {
    expect(parseRpcUrls(['https://a.example', 'https://a.example', 'https://b.example'])).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('deduplicates before applying the cap so the effective chain matches operator intent', () => {
    const result = parseRpcUrls([
      'https://a.example',
      'https://a.example',
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
      'https://e.example',
    ]);
    expect(result).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
    ]);
  });
});

describe('buildFallbackTransport (relayer)', () => {
  it('returns a viem transport whose type is "fallback"', () => {
    const transport = buildFallbackTransport(['https://a.example']);
    const client = createPublicClient({ chain: mainnet, transport });
    expect(client.transport.type).toBe('fallback');
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

  it('re-throws viem ExecutionRevertedError without wrapping', async () => {
    const reverted = Object.assign(new Error('execution reverted: bad'), {
      name: 'ExecutionRevertedError',
      code: 3,
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
  });

  it('re-throws CAIP user-rejected (code 5000) without wrapping', async () => {
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
  });
});

describe('describeFallbackChain (relayer)', () => {
  it('formats the boot-log summary line', () => {
    expect(describeFallbackChain(['https://a.example/path', 'https://b.example/path'])).toBe(
      'fallback chain (2 providers) — primary=a.example',
    );
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

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
