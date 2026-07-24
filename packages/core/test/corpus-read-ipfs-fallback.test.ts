import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFromIpfs } from '../src/corpus-read/ipfs.js';

describe('fetchFromIpfs fallbackGatewayBase (#1648)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not request ipfs.io after primary 404 when fallbackGatewayBase is false', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        return new Response('missing', { status: 404, statusText: 'Not Found' });
      }),
    );

    await expect(
      fetchFromIpfs('http://127.0.0.1:9999', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', {
        fallbackGatewayBase: false,
      }),
    ).rejects.toThrow(/IPFS JSON fetch failed after all candidates/);

    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => url.startsWith('http://127.0.0.1:9999/'))).toBe(true);
    expect(requested.some((url) => url.includes('ipfs.io'))).toBe(false);
  });

  it('still retries ipfs.io after primary 404 when opts are omitted (production default)', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        return new Response('missing', { status: 404, statusText: 'Not Found' });
      }),
    );

    await expect(
      fetchFromIpfs(
        'http://127.0.0.1:9999',
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ),
    ).rejects.toThrow(/IPFS JSON fetch failed after all candidates/);

    expect(requested.some((url) => url.startsWith('https://ipfs.io/ipfs/'))).toBe(true);
  });

  it('uses a custom fallbackGatewayBase string when provided', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes('fallback.example')) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('missing', { status: 404, statusText: 'Not Found' });
      }),
    );

    const result = await fetchFromIpfs(
      'http://127.0.0.1:9999',
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      { fallbackGatewayBase: 'https://fallback.example' },
    );

    expect(result).toEqual({ ok: true });
    expect(requested.some((url) => url.startsWith('https://fallback.example/ipfs/'))).toBe(true);
    expect(requested.some((url) => url.includes('ipfs.io'))).toBe(false);
  });
});
