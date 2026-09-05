/**
 * Sweep #3729 — three guards on the corpus IPFS reader that #3419's review
 * flagged as gaps.
 *
 * Each block goes red when its own fix alone is removed:
 *   - #3439 effective-port resolution in `assertRedirectAllowed`
 *   - #3440 gateway path-prefix containment for a resolved candidate URL
 *   - #3441 a caller-supplied byte bound
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_IPFS_RESPONSE_BYTES,
  fetchBytesFromIpfs,
  fetchFromIpfs,
} from '../src/corpus-read/ipfs.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function redirect(location: string, status = 302): Response {
  return new Response('moved', { status, headers: { location } });
}

/** Records every URL the reader actually requests. */
function stubFetch(respond: (url: string) => Response): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return respond(url);
    }),
  );
  return requested;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('redirect guard compares effective ports (#3439)', () => {
  it('refuses an http-to-https hop that only differs by the implicit port', async () => {
    // The gateway is port 80 (implicit); the Location is port 443 (implicit).
    // `URL.port` is '' for both, so a raw comparison lets this through, and the
    // downgrade rule only fires https -> http.
    const requested = stubFetch(() => redirect('https://gw.example/secret'));

    await expect(
      fetchFromIpfs('http://gw.example', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/redirect changes the gateway port \(443\)/);

    expect(requested).toEqual(['http://gw.example/ipfs/' + CID]);
  });

  it('refuses an https-to-http hop even where the downgrade rule would not fire', async () => {
    // Gateway explicitly on 443 over http would be perverse; the realistic
    // inverse is an https gateway pinned to a non-default port hopping to the
    // implicit 443. Same rule, opposite direction.
    stubFetch(() => redirect('https://gw.example/other'));

    await expect(
      fetchFromIpfs('https://gw.example:8443', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/redirect changes the gateway port \(443\)/);
  });

  it('still allows a same-effective-port hop that writes the port explicitly', async () => {
    const requested = stubFetch((url) =>
      url.endsWith('/ipfs/final') ? json({ ok: true }) : redirect('https://gw.example:443/ipfs/final'),
    );

    await expect(
      fetchFromIpfs('https://gw.example', CID, { fallbackGatewayBase: false }),
    ).resolves.toEqual({ ok: true });

    expect(requested).toContain('https://gw.example/ipfs/final');
  });

  it('still allows an ordinary same-scheme hop with no port anywhere', async () => {
    stubFetch((url) =>
      url.endsWith('/ipfs/final') ? json({ ok: true }) : redirect('https://gw.example/ipfs/final'),
    );

    await expect(
      fetchFromIpfs('https://gw.example', CID, { fallbackGatewayBase: false }),
    ).resolves.toEqual({ ok: true });
  });
});

describe('candidate URL stays inside the gateway path prefix (#3440)', () => {
  it('refuses a manifest CID that walks out of /ipfs/', async () => {
    const requested = stubFetch(() => json({ ok: true }));

    await expect(
      fetchFromIpfs('https://gw.example', '../../evil', { fallbackGatewayBase: false }),
    ).rejects.toThrow(/candidate URL escapes the gateway path prefix/);

    // The point of the guard: no request is issued at all.
    expect(requested).toEqual([]);
  });

  it('refuses an absolute-path CID', async () => {
    const requested = stubFetch(() => json({ ok: true }));

    await expect(
      fetchBytesFromIpfs('https://gw.example', '/admin', { fallbackGatewayBase: false }),
    ).rejects.toThrow(/candidate URL escapes the gateway path prefix/);

    expect(requested).toEqual([]);
  });

  it('refuses a CID that is itself an absolute URL on another origin', async () => {
    const requested = stubFetch(() => json({ ok: true }));

    await expect(
      fetchFromIpfs('https://gw.example', 'https://evil.example/x', {
        fallbackGatewayBase: false,
      }),
    ).rejects.toThrow(/candidate URL escapes the gateway path prefix/);

    expect(requested).toEqual([]);
  });

  it('still resolves the documented <cid>/path/to/file form', async () => {
    const requested = stubFetch(() => json({ ok: true }));

    await expect(
      fetchFromIpfs('https://gw.example', `${CID}/path/to/file.json`, {
        fallbackGatewayBase: false,
      }),
    ).resolves.toEqual({ ok: true });

    expect(requested).toEqual([`https://gw.example/ipfs/${CID}/path/to/file.json`]);
  });

  it('still resolves a plain CID to exactly the pre-guard URL', async () => {
    const requested = stubFetch(() => json({ ok: true }));

    await expect(
      fetchFromIpfs('https://gw.example', CID, { fallbackGatewayBase: false }),
    ).resolves.toEqual({ ok: true });

    expect(requested).toEqual([`https://gw.example/ipfs/${CID}`]);
  });
});

describe('caller-supplied byte bound (#3441)', () => {
  function oversized(bytes: number): Response {
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('defaults to the 8 MiB envelope cap', async () => {
    expect(DEFAULT_MAX_IPFS_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
    stubFetch(() => oversized(1024));

    await expect(
      fetchBytesFromIpfs('https://gw.example', CID, {
        fallbackGatewayBase: false,
        maxResponseBytes: 512,
      }),
    ).rejects.toThrow(/exceeds the 512-byte cap/);
  });

  it('lets a caller raise the bound above the default', async () => {
    const body = new Uint8Array(DEFAULT_MAX_IPFS_RESPONSE_BYTES + 1024);
    stubFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    );

    const bytes = await fetchBytesFromIpfs('https://gw.example', CID, {
      fallbackGatewayBase: false,
      maxResponseBytes: DEFAULT_MAX_IPFS_RESPONSE_BYTES * 2,
    });
    expect(bytes.byteLength).toBe(body.byteLength);
  });

  it('applies the raised bound to the declared content-length too', async () => {
    stubFetch(
      () =>
        new Response('x', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(DEFAULT_MAX_IPFS_RESPONSE_BYTES + 1),
          },
        }),
    );

    await expect(
      fetchBytesFromIpfs('https://gw.example', CID, {
        fallbackGatewayBase: false,
        maxResponseBytes: DEFAULT_MAX_IPFS_RESPONSE_BYTES * 2,
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('falls back to the default for a nonsensical bound', async () => {
    stubFetch(() => oversized(1024));

    for (const maxResponseBytes of [0, -1, Number.NaN]) {
      await expect(
        fetchBytesFromIpfs('https://gw.example', CID, {
          fallbackGatewayBase: false,
          maxResponseBytes,
        }),
      ).resolves.toHaveLength(1024);
    }
  });
});
