/**
 * Tests for the IPFS gateway fetch helper (src/ipfs.ts).
 */
import { describe, it, expect } from 'vitest';
import { normalizeIpfsGatewayBase, fetchIpfsJson, DEFAULT_IPFS_GATEWAY, type FetchLike } from '../src/ipfs.js';

describe('normalizeIpfsGatewayBase', () => {
  it('appends /ipfs/ to a plain base URL', () => {
    expect(normalizeIpfsGatewayBase('https://x')).toBe('https://x/ipfs/');
  });

  it('removes trailing slash then appends /ipfs/', () => {
    expect(normalizeIpfsGatewayBase('https://x/')).toBe('https://x/ipfs/');
  });

  it('keeps /ipfs when already present, just adds trailing slash', () => {
    expect(normalizeIpfsGatewayBase('https://x/ipfs')).toBe('https://x/ipfs/');
  });

  it('is idempotent when already ends with /ipfs/', () => {
    expect(normalizeIpfsGatewayBase('https://x/ipfs/')).toBe('https://x/ipfs/');
  });

  it('empty string → DEFAULT_IPFS_GATEWAY/ipfs/', () => {
    expect(normalizeIpfsGatewayBase('')).toBe(`${DEFAULT_IPFS_GATEWAY}/ipfs/`);
  });

  it('undefined → DEFAULT_IPFS_GATEWAY/ipfs/', () => {
    expect(normalizeIpfsGatewayBase(undefined)).toBe(`${DEFAULT_IPFS_GATEWAY}/ipfs/`);
  });

  it('removes multiple trailing slashes', () => {
    expect(normalizeIpfsGatewayBase('https://x///')).toBe('https://x/ipfs/');
  });
});

describe('fetchIpfsJson', () => {
  it('resolves to the parsed JSON body on a successful fetch', async () => {
    const stubFetch: FetchLike = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => ({ hello: 'world' }),
    });

    const result = await fetchIpfsJson('https://stub', 'bafycid', { fetchImpl: stubFetch });
    expect(result).toEqual({ hello: 'world' });
  });

  it('calls the fetch with the correct URL composed from gateway + cid', async () => {
    let capturedUrl = '';
    const stubFetch: FetchLike = async (url, _opts) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    await fetchIpfsJson('https://gw', 'bafytest', { fetchImpl: stubFetch });
    expect(capturedUrl).toBe('https://gw/ipfs/bafytest');
  });

  it('rejects on a non-2xx response', async () => {
    const stubFetch: FetchLike = async (_url, _opts) => ({ ok: false, status: 404, json: async () => null });

    await expect(fetchIpfsJson('https://stub', 'bafycid', { fetchImpl: stubFetch })).rejects.toThrow(
      'IPFS gateway 404',
    );
  });

  it('passes an AbortSignal in the fetch options', async () => {
    let capturedOptions: RequestInit | undefined;
    const stubFetch: FetchLike = async (_url, opts) => {
      capturedOptions = opts;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    await fetchIpfsJson('https://stub', 'bafycid', { fetchImpl: stubFetch });
    expect(capturedOptions?.signal).toBeDefined();
  });
});
