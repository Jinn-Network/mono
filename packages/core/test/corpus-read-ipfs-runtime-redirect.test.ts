/**
 * Redirect handling pinned against the real fetch runtime (#3442 item 1).
 *
 * The mocked suite asserts `expect(init?.redirect).toBe('manual')` — a
 * white-box check on the init literal that cannot observe what the runtime
 * does with it. The fetch spec permits an opaque-redirect filtered response
 * (status 0, no headers) for `redirect: 'manual'`; under such a runtime every
 * real redirect would collapse into `IPFS fetch failed: 0` and the mocked
 * suite would stay green. These tests use a `node:http` server and the real
 * global `fetch`, so they fail if either the flag or the hop loop stops
 * working end to end.
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchFromIpfs } from '../src/corpus-read/ipfs.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

type Handler = (path: string) => { status: number; headers?: Record<string, string>; body?: string };

const servers: Server[] = [];

async function startServer(handler: Handler): Promise<{ base: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    paths.push(path);
    const { status, headers, body } = handler(path);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body ?? '');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, paths };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => { resolve(); })),
    ),
  );
});

describe('IPFS redirect handling against the real fetch runtime (#3442)', () => {
  it('reads the 3xx and follows the Location itself', async () => {
    const gateway = await startServer((path) =>
      path === `/ipfs/${CID}`
        ? { status: 302, headers: { location: '/ipfs/final' }, body: 'moved' }
        : { status: 200, body: JSON.stringify({ ok: true }) },
    );

    await expect(
      fetchFromIpfs(gateway.base, CID, { fallbackGatewayBase: false }),
    ).resolves.toEqual({ ok: true });

    // Both hops were issued by this reader, and the 3xx was readable — an
    // opaque-redirect response would have surfaced as `IPFS fetch failed: 0`.
    expect(gateway.paths).toEqual([`/ipfs/${CID}`, '/ipfs/final']);
  });

  it('never issues an off-gateway hop the guard refused', async () => {
    // A second live server stands in for the redirect target. With
    // `redirect: 'follow'` the runtime would chase it before the guard could
    // look, and this server would record a request.
    const elsewhere = await startServer(() => ({ status: 200, body: '"pwned"' }));
    const gateway = await startServer(() => ({
      status: 302,
      headers: { location: `${elsewhere.base}/latest/meta-data/` },
      body: 'moved',
    }));

    await expect(
      fetchFromIpfs(gateway.base, CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/redirect (leaves the configured gateway|changes the gateway port)/);

    expect(elsewhere.paths).toEqual([]);
  });

  it('stops a redirect loop at the hop cap instead of following it forever', async () => {
    const gateway = await startServer((path) => ({
      status: 302,
      headers: { location: `${path}/again` },
      body: 'moved',
    }));

    await expect(
      fetchFromIpfs(gateway.base, CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/exceeded 3 redirects/);

    expect(gateway.paths).toHaveLength(4);
  });
});
