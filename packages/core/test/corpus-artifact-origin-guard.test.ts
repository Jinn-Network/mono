/**
 * #1901 — corpus artifact origin fetches must be destination-restricted and
 * resource-bounded before integrity verification runs.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyIpAddress,
  resolvePublicHttpDestination,
  ProhibitedDestinationError,
} from '../src/corpus-read/origin-guard.js';
import { pinnedFetch } from '../src/corpus-read/pinned-fetch.js';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fetchArtifactContent, buildArtifactUrl } from '../src/corpus-read/fetch-artifact.js';
import { acquireArtifactContent } from '../src/corpus-read/acquire.js';
import type { CorpusStorePort, SaveNetworkArtifactInput } from '../src/corpus-read/types.js';
import { createHash } from 'node:crypto';

const SHA = 'a'.repeat(64);
const publicResolver = async () => ['93.184.216.34'];

function jsonResponse(body: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

describe('classifyIpAddress (#1901)', () => {
  it('accepts ordinary public addresses', () => {
    expect(classifyIpAddress('93.184.216.34')).toBe('public');
    expect(classifyIpAddress('8.8.8.8')).toBe('public');
    expect(classifyIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe('public');
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-nat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.5', 'documentation'],
  ])('refuses IPv4 %s as %s', (ip, reason) => {
    expect(classifyIpAddress(ip)).toBe(reason);
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
  ])('refuses IPv6 %s as %s', (ip, reason) => {
    expect(classifyIpAddress(ip)).toBe(reason);
  });

  it('unwraps embedded IPv4 so loopback cannot be smuggled through IPv6 forms', () => {
    expect(classifyIpAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyIpAddress('::ffff:169.254.169.254')).toBe('link-local');
    expect(classifyIpAddress('64:ff9b::192.168.0.1')).toBe('private');
    expect(classifyIpAddress('2002:7f00:1::')).toBe('loopback');
  });

  it('refuses anything it cannot parse', () => {
    expect(classifyIpAddress('not-an-ip')).toBe('unparsable');
    expect(classifyIpAddress('1.2.3.4.5')).toBe('unparsable');
  });
});

describe('resolvePublicHttpDestination (#1901)', () => {
  it('accepts a credential-free public https destination and returns the address to pin', async () => {
    await expect(resolvePublicHttpDestination(
      new URL('https://op.example.com/v1'), { resolveHostname: publicResolver },
    )).resolves.toEqual({ addresses: [{ address: '93.184.216.34', family: 4 }] });
  });

  it('pins a literal-IP host to itself', async () => {
    await expect(resolvePublicHttpDestination(
      new URL('https://93.184.216.34/v1'), { resolveHostname: publicResolver },
    )).resolves.toEqual({ addresses: [{ address: '93.184.216.34', family: 4 }] });
  });

  it('keeps every validated address so the transport can still fail over', async () => {
    await expect(resolvePublicHttpDestination(
      new URL('https://dual.example.com/v1'),
      { resolveHostname: async () => ['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34'] },
    )).resolves.toEqual({
      addresses: [
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ],
    });
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/'])(
    'refuses the %s scheme', async (raw) => {
      await expect(resolvePublicHttpDestination(
        new URL(raw), { resolveHostname: publicResolver },
      )).rejects.toThrow(ProhibitedDestinationError);
    });

  it('refuses credential-bearing URLs', async () => {
    await expect(resolvePublicHttpDestination(
      new URL('https://user:secret@op.example.com/'), { resolveHostname: publicResolver },
    )).rejects.toThrow(/credentials/u);
  });

  it('refuses literal loopback and metadata hosts without consulting DNS', async () => {
    const resolveHostname = vi.fn(publicResolver);
    await expect(resolvePublicHttpDestination(
      new URL('http://127.0.0.1:7331/'), { resolveHostname },
    )).rejects.toThrow(/loopback/u);
    await expect(resolvePublicHttpDestination(
      new URL('http://169.254.169.254/latest/meta-data/'), { resolveHostname },
    )).rejects.toThrow(/link-local/u);
    await expect(resolvePublicHttpDestination(
      new URL('http://[::1]:7331/'), { resolveHostname },
    )).rejects.toThrow(/loopback/u);
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it('refuses a public-looking name that resolves into private space', async () => {
    await expect(resolvePublicHttpDestination(
      new URL('https://rebind.example.com/'),
      { resolveHostname: async () => ['10.1.2.3'] },
    )).rejects.toThrow(/private/u);
  });

  it('refuses when any one of several resolved addresses is prohibited', async () => {
    await expect(resolvePublicHttpDestination(
      new URL('https://mixed.example.com/'),
      { resolveHostname: async () => ['93.184.216.34', '127.0.0.1'] },
    )).rejects.toThrow(/loopback/u);
  });

  it('refuses a host that resolves to nothing', async () => {
    await expect(resolvePublicHttpDestination(
      new URL('https://void.example.com/'), { resolveHostname: async () => [] },
    )).rejects.toThrow(ProhibitedDestinationError);
  });

  it('still refuses non-http schemes and credentials when private destinations are allowed', async () => {
    await expect(resolvePublicHttpDestination(
      new URL('file:///etc/passwd'), { allowPrivateDestinations: true },
    )).rejects.toThrow(/http/u);
    await expect(resolvePublicHttpDestination(
      new URL('http://user:secret@127.0.0.1:7331/'), { allowPrivateDestinations: true },
    )).rejects.toThrow(/credentials/u);
    await expect(resolvePublicHttpDestination(
      new URL('http://127.0.0.1:7331/'), { allowPrivateDestinations: true },
    )).resolves.toBeNull();
  });
});

describe('fetchArtifactContent destination policy (#1901)', () => {
  it('never contacts a prohibited destination', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchArtifactContent('http://169.254.169.254', SHA, { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a file: endpoint', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchArtifactContent('file:///etc', SHA, { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches a bounded public response', async () => {
    const body = Buffer.from('artifact bytes', 'utf-8');
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl, resolveHostname: publicResolver,
    });
    expect(result).toEqual({ ok: true, content: body });
    expect(fetchImpl.mock.calls[0][0].toString()).toBe(buildArtifactUrl('https://op.example.com', SHA));
  });

  it('maps 404 to not_found and other failures to network_error', async () => {
    const notFound = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl: async () => new Response(null, { status: 404 }), resolveHostname: publicResolver,
    });
    expect(notFound).toMatchObject({ ok: false, reason: 'not_found' });
    const serverError = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl: async () => new Response(null, { status: 500 }), resolveHostname: publicResolver,
    });
    expect(serverError).toMatchObject({ ok: false, reason: 'network_error' });
  });
});

describe('fetchArtifactContent redirect handling (#1901)', () => {
  function redirectTo(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
  }

  it('revalidates every hop and refuses a redirect into private space', async () => {
    const fetchImpl = vi.fn(async () => redirectTo('http://169.254.169.254/latest/meta-data/'));
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl, resolveHostname: publicResolver,
    });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl: async () => redirectTo('file:///etc/passwd'), resolveHostname: publicResolver,
    });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('follows a bounded chain of public redirects', async () => {
    const body = Buffer.from('final bytes', 'utf-8');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(redirectTo('https://cdn.example.com/blob'))
      .mockResolvedValueOnce(jsonResponse(body));
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl, resolveHostname: publicResolver,
    });
    expect(result).toEqual({ ok: true, content: body });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('abandons the body of a redirect that carries no Location', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
      pull(controller) { controller.enqueue(new Uint8Array(1024)); },
    });
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl: async () => new Response(body, { status: 302 }),
      resolveHostname: publicResolver,
    });
    expect(result).toMatchObject({ ok: false, reason: 'network_error' });
    expect(cancelled).toBe(true);
  });

  it('caps the redirect chain', async () => {
    let hop = 0;
    const fetchImpl = vi.fn(async () => redirectTo(`https://op.example.com/hop${hop++}`));
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl, resolveHostname: publicResolver, maxRedirects: 2,
    });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('fetchArtifactContent resource bounds (#1901)', () => {
  it('aborts a response that exceeds the byte cap without buffering it whole', async () => {
    let emitted = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(16));
      },
      cancel() { cancelled = true; },
    });
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl: async () => new Response(stream, { status: 200 }),
      resolveHostname: publicResolver,
      maxBytes: 32,
    });
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    expect(cancelled).toBe(true);
    // The cap is enforced while streaming, not after buffering an unbounded body.
    expect(emitted).toBeLessThan(10);
  });

  it('rejects an oversized content-length and abandons the body undrained', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(64)); },
      cancel() { cancelled = true; },
    });
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl: async () => new Response(stream, {
        status: 200, headers: { 'content-length': '999999999' },
      }),
      resolveHostname: publicResolver,
      maxBytes: 1024,
    });
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    expect(cancelled).toBe(true);
    // Only the stream's own eager pre-pull ran; we never drained it ourselves.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it('aborts a stalled response and persists nothing', async () => {
    const aborted = vi.fn();
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', aborted);
      return new Promise<Response>(() => { /* never settles */ });
    });
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl, resolveHostname: publicResolver, timeoutMs: 20,
    });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(aborted).toHaveBeenCalled();
  });

  it('aborts a body that stalls mid-stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8)); },
      pull() { return new Promise<void>(() => { /* stalls */ }); },
    });
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl: async () => new Response(stream, { status: 200 }),
      resolveHostname: publicResolver,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('acquireArtifactContent over the guarded fetch (#1901)', () => {
  const store = () => {
    const saved: SaveNetworkArtifactInput[] = [];
    const port: CorpusStorePort = {
      getNetworkArtifact: () => null,
      touchNetworkArtifactUsage: () => {},
      saveNetworkArtifact: (input) => { saved.push(input); },
      getServedArtifact: () => null,
    };
    return { port, saved };
  };

  const acquire = (bytes: Buffer, expected: string, saveTo: CorpusStorePort) =>
    acquireArtifactContent({
      sha256: expected,
      artifactType: 'output.prediction.v0',
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      store: saveTo,
      selfSafeAddress: '0x' + '1'.repeat(40),
      privateKey: '0x' + '2'.repeat(64),
      acquireFn: (endpoint, sha) => fetchArtifactContent(endpoint, sha, {
        fetchImpl: async () => new Response(bytes, { status: 200 }),
        resolveHostname: publicResolver,
      }),
    });

  it('succeeds for a bounded public response whose bytes hash as expected', async () => {
    const bytes = Buffer.from('verified artifact bytes', 'utf-8');
    const expected = createHash('sha256').update(bytes).digest('hex');
    const { port, saved } = store();
    const content = await acquire(bytes, expected, port);
    expect(content.bytes).toEqual(bytes);
    expect(content.source).toBe('origin');
    expect(saved).toHaveLength(1);
  });

  it('stores nothing when the delivered bytes do not hash to the expected digest', async () => {
    const { port, saved } = store();
    await expect(acquire(Buffer.from('tampered', 'utf-8'), SHA, port))
      .rejects.toThrow(/hash mismatch|HashMismatch/iu);
    expect(saved).toEqual([]);
  });

  it('surfaces a blocked destination as an AcquireError rather than fetching it', async () => {
    const fetchImpl = vi.fn();
    const { port, saved } = store();
    await expect(acquireArtifactContent({
      sha256: SHA,
      artifactType: 'output.prediction.v0',
      access: { endpoint: 'http://169.254.169.254', priceUsdc: '0' },
      store: port,
      selfSafeAddress: '0x' + '1'.repeat(40),
      privateKey: '0x' + '2'.repeat(64),
      acquireFn: (endpoint, sha) => fetchArtifactContent(endpoint, sha, { fetchImpl }),
    })).rejects.toThrow(/blocked/u);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });
});

describe('address pinning defeats DNS rebinding (#1901)', () => {
  it('refuses the IPv6 forms that are not globally routable', () => {
    // Deny-by-default: anything outside global unicast (2000::/3), and the
    // zero-prefix space where IPv4-compatible / IPv4-translated forms live.
    expect(classifyIpAddress('fec0::1')).toBe('private');          // site-local
    expect(classifyIpAddress('::127.0.0.1')).toBe('reserved');     // IPv4-compatible
    expect(classifyIpAddress('::ffff:0:127.0.0.1')).toBe('reserved'); // IPv4-translated
    expect(classifyIpAddress('2001::7f00:1')).toBe('reserved');    // Teredo
    expect(classifyIpAddress('64:ff9b:1::a9fe:a9fe')).toBe('reserved'); // local-use NAT64
    expect(classifyIpAddress('5f00::1')).toBe('reserved');
    expect(classifyIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe('public');
  });

  it('connects to the pinned address, not to whatever the hostname resolves to', async () => {
    // `.invalid` is guaranteed never to resolve (RFC 6761), so a successful
    // request proves the socket used the pinned address and never consulted
    // DNS — which is exactly what makes a rebinding answer unreachable.
    const server = createServer((_req, res) => { res.writeHead(200); res.end('pinned-body'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(pinnedFetch(new URL(`http://rebind.example.invalid:${port}/x`)))
        .rejects.toThrow();
      const response = await pinnedFetch(new URL(`http://rebind.example.invalid:${port}/x`), {
        pinnedAddresses: [{ address: '127.0.0.1', family: 4 }],
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('pinned-body');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('hands the guard-approved address to the transport on every hop', async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (_url: URL, init?: { pinnedAddresses?: readonly { address: string }[] }) => {
      seen.push(init?.pinnedAddresses?.[0]?.address);
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/b' } })
        : new Response(Buffer.from('ok', 'utf-8'), { status: 200 });
    });
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl,
      resolveHostname: async (host) =>
        host === 'op.example.com' ? ['93.184.216.34'] : ['151.101.1.1'],
    });
    expect(result).toMatchObject({ ok: true });
    expect(seen).toEqual(['93.184.216.34', '151.101.1.1']);
  });

  it('refuses a name whose answers mix public and private, rather than pinning the public one', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchArtifactContent('https://mixed.example.com', SHA, {
      fetchImpl, resolveHostname: async () => ['93.184.216.34', '169.254.169.254'],
    });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the deadline covers the destination guard (#1901)', () => {
  it('returns a timeout instead of hanging when DNS never answers', async () => {
    const result = await fetchArtifactContent('https://slow.example.com', SHA, {
      fetchImpl: async () => new Response(Buffer.from('x', 'utf-8'), { status: 200 }),
      resolveHostname: () => new Promise<string[]>(() => { /* never answers */ }),
      timeoutMs: 30,
    });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('returns a timeout when a later hop stalls in DNS', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://stall.example.com/b' } }));
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl,
      resolveHostname: async (host) => host === 'op.example.com'
        ? ['93.184.216.34']
        : new Promise<string[]>(() => { /* never answers */ }),
      timeoutMs: 30,
    });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('obfuscated and credential-bearing destinations (#1901)', () => {
  it.each([
    'http://0177.0.0.1',
    'http://2130706433',
    'http://0x7f.1',
    'http://[::ffff:127.0.0.1]',
  ])('refuses the loopback spelling %s end to end', async (endpoint) => {
    const fetchImpl = vi.fn();
    const result = await fetchArtifactContent(endpoint, SHA, { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a redirect whose Location carries credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'https://user:secret@cdn.example.com/b' },
    }));
    const result = await fetchArtifactContent('https://op.example.com', SHA, {
      fetchImpl, resolveHostname: publicResolver,
    });
    expect(result).toMatchObject({ ok: false, reason: 'blocked', message: expect.stringMatching(/credentials/u) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('a hostile response cannot kill the process (#1901)', () => {
  /** Serve a hand-written response so we control bytes the HTTP layer sees. */
  const rawServer = async (raw: string) => {
    // Reply only once the request has actually arrived — writing first and
    // half-closing races the client's own write and never gets parsed.
    const server = createNetServer((socket) => {
      socket.once('data', () => { socket.end(raw); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
  };

  it.each([
    ['205 Reset Content', 'HTTP/1.1 205 Reset Content\r\nContent-Length: 5\r\n\r\nhello'],
    ['204 No Content', 'HTTP/1.1 204 No Content\r\n\r\n'],
    ['304 Not Modified', 'HTTP/1.1 304 Not Modified\r\n\r\n'],
  ])('handles a bodyless %s without throwing out of the response callback', async (_label, raw) => {
    // A throw inside http.request's response callback is an uncaught
    // exception — unreachable by the caller's try/catch and fatal to the
    // daemon. These statuses reject a body in the Response constructor.
    const { server, port } = await rawServer(raw);
    try {
      const response = await pinnedFetch(new URL(`http://origin.example.invalid:${port}/x`), {
        pinnedAddresses: [{ address: '127.0.0.1', family: 4 }],
      });
      expect(response.body).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ['600', 'HTTP/1.1 600 Nope\r\nContent-Length: 2\r\n\r\nhi'],
    ['999', 'HTTP/1.1 999 Nope\r\nContent-Length: 2\r\n\r\nhi'],
  ])('rejects an out-of-range HTTP status %s instead of throwing', async (_label, raw) => {
    // Node's parser accepts these; the Response constructor throws on them.
    const { server, port } = await rawServer(raw);
    try {
      await expect(pinnedFetch(new URL(`http://origin.example.invalid:${port}/x`), {
        pinnedAddresses: [{ address: '127.0.0.1', family: 4 }],
      })).rejects.toThrow(/out-of-range HTTP status/u);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses an empty pin list rather than silently resolving by DNS', async () => {
    // `undefined` means no pin; `[]` means "pinned, nothing allowed" and must
    // never degrade into an unrestricted lookup.
    await expect(pinnedFetch(new URL('http://example.com/x'), { pinnedAddresses: [] }))
      .rejects.toThrow(/must not be empty/u);
  });

  it('refuses a pin whose address does not match its declared family', async () => {
    await expect(pinnedFetch(new URL('http://example.com/x'), {
      pinnedAddresses: [{ address: '127.0.0.1', family: 6 }],
    })).rejects.toThrow(/not a numeric IPv6 address/u);
  });

  it('surfaces a 205 origin as an ordinary failed acquisition, not a crash', async () => {
    const { server, port } = await rawServer(
      'HTTP/1.1 205 Reset Content\r\nContent-Length: 5\r\n\r\nhello');
    try {
      const result = await fetchArtifactContent(`http://origin.example.invalid:${port}`, SHA, {
        allowPrivateDestinations: true, timeoutMs: 4000,
      });
      expect(result).toMatchObject({ ok: false, reason: 'network_error' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
