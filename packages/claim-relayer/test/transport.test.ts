/**
 * Unit tests for the relayer's inline RPC transport helper — mirrors
 * `client/src/rpc/transport.ts` (Jinn issue #592). Intentional duplication;
 * keep behaviour aligned across packages.
 */

import { describe, expect, it } from 'vitest';
import { createPublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import {
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
});

describe('describeFallbackChain (relayer)', () => {
  it('formats the boot-log summary line', () => {
    expect(describeFallbackChain(['https://a.example/path', 'https://b.example/path'])).toBe(
      'fallback chain (2 providers) — primary=a.example',
    );
  });
});
