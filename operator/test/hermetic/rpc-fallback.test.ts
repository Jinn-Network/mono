/**
 * Hermetic gate — deterministic RPC fallback-chain test (#592).
 *
 * Spec: docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md
 * §3.1 ("Deterministic RPC-fallback test (mock returning 429/5xx) exercises the
 * `fallback()` chain (#592) without a real provider").
 *
 * The hermetic gate proves the *logic* of the multi-RPC fallback chain with
 * zero external dependencies: every slot is a viem `custom()` transport driven
 * by a `vi.fn()`, so the test is sub-second and can never flake for infra
 * reasons. It exercises the failure modes operators actually hit on Base
 * Sepolia's public chain — HTTP 429 (rate-limited primary) and HTTP 5xx
 * (provider 502/503) — and asserts the chain fails over primary→secondary and
 * surfaces the structured `AllRpcsFailedError` (masked host list) only when
 * every slot is exhausted.
 *
 * This is the deterministic sibling of the broader unit suite in
 * `test/rpc/transport.test.ts`; it lives in the hermetic home so the per-PR
 * gate owns the fallback-logic regression surface (spec §6, "RPC fallback
 * *logic* — [new] deterministic 429/5xx mock"). It deliberately drives the
 * 5xx case the unit suite did not cover.
 *
 * Under test: operator/src/rpc/transport.ts (buildFromTransports, AllRpcsFailedError).
 */

import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, HttpRequestError, type Transport } from 'viem';
import { mainnet } from 'viem/chains';
import {
  buildFallbackTransport,
  AllRpcsFailedError,
} from '../../src/rpc/transport.js';

/**
 * Build a fallback transport from a list of mock request fns + URLs so the test
 * can drive each slot deterministically with no real HTTP. The transport keys
 * match the URLs so `AllRpcsFailedError.providers` reports the right (masked)
 * host list.
 */
function buildFallbackTransportFromMocks(
  requestFns: ReadonlyArray<(args: { method: string; params: unknown[] }) => Promise<unknown>>,
  urls: readonly string[],
): Transport {
  if (requestFns.length !== urls.length) {
    throw new Error('buildFallbackTransportFromMocks: requestFns length must match urls');
  }
  const transports = requestFns.map((fn, i) =>
    custom(
      { request: fn as (args: { method: string; params: unknown[] }) => Promise<unknown> },
      { key: urls[i], name: urls[i] },
    ),
  );
  return buildFallbackTransport.buildFromTransports(transports, urls);
}

/** A viem HttpRequestError carrying a specific HTTP status, as the http() transport throws. */
function httpStatusError(status: number, method = 'eth_blockNumber'): HttpRequestError {
  return new HttpRequestError({
    body: { method, params: [] },
    details: `HTTP ${status}`,
    status,
    url: 'https://primary.example',
  });
}

describe('hermetic rpc-fallback chain (#592)', () => {
  it('fails over primary→secondary on HTTP 429 (rate-limited primary)', async () => {
    const primary = vi.fn(async () => {
      throw httpStatusError(429);
    });
    const secondary = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_blockNumber') return '0x2a';
      return null;
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://primary.example',
      'https://secondary.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    const blockNumber = await client.getBlockNumber();
    expect(blockNumber).toBe(0x2an);
    expect(primary).toHaveBeenCalled();
    expect(secondary).toHaveBeenCalled();
  });

  it('fails over primary→secondary on HTTP 503 (provider 5xx)', async () => {
    const primary = vi.fn(async () => {
      throw httpStatusError(503);
    });
    const secondary = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_blockNumber') return '0x35';
      return null;
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://primary.example',
      'https://secondary.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    const blockNumber = await client.getBlockNumber();
    expect(blockNumber).toBe(0x35n);
    expect(secondary).toHaveBeenCalled();
  });

  it('walks the full chain — primary 502 → secondary 429 → tertiary success', async () => {
    const calls: string[] = [];
    const primary = vi.fn(async () => {
      calls.push('primary');
      throw httpStatusError(502);
    });
    const secondary = vi.fn(async () => {
      calls.push('secondary');
      throw httpStatusError(429);
    });
    const tertiary = vi.fn(async ({ method }: { method: string }) => {
      calls.push('tertiary');
      if (method === 'eth_blockNumber') return '0x99';
      return null;
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary, tertiary], [
      'https://primary.example',
      'https://secondary.example',
      'https://tertiary.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    const blockNumber = await client.getBlockNumber();
    expect(blockNumber).toBe(0x99n);
    // rank: false — order is preserved (the "Tenderly stays in slot 3" constraint).
    expect(calls).toEqual(['primary', 'secondary', 'tertiary']);
  });

  it('rejects with AllRpcsFailedError carrying masked hosts when every slot 5xx/429s', async () => {
    const primary = vi.fn(async () => {
      throw httpStatusError(500);
    });
    const secondary = vi.fn(async () => {
      throw httpStatusError(429);
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://primary.example/api-key/secret',
      'https://secondary.example/api-key/secret',
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
      // Masked to hostnames only — the api-key path must not leak into the error.
      expect(caught.providers).toEqual(['primary.example', 'secondary.example']);
      expect(caught.message).not.toContain('api-key');
    }
    expect(primary).toHaveBeenCalled();
    expect(secondary).toHaveBeenCalled();
  });

  it('does not consult the secondary when the primary succeeds', async () => {
    const primary = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_blockNumber') return '0x1';
      return null;
    });
    const secondary = vi.fn(async () => {
      throw new Error('secondary must not be called when primary succeeds');
    });

    const transport = buildFallbackTransportFromMocks([primary, secondary], [
      'https://primary.example',
      'https://secondary.example',
    ]);
    const client = createPublicClient({ chain: mainnet, transport });

    await client.getBlockNumber();
    expect(primary).toHaveBeenCalled();
    expect(secondary).not.toHaveBeenCalled();
  });
});
