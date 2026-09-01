import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBaseSepoliaRecordTransport,
  NativeRecordDestinationError,
} from '../../src/daemon/native-base-sepolia-infrastructure.js';

// Every other test of this transport injects a `fetchImpl`, so nothing exercised the real primitive
// the daemon ships with. A mock ignores the `redirect` option entirely: delete `redirect: 'manual'`
// from `fetchBytes` and every mocked redirect test stays green, while the real primitive falls back
// to `redirect: 'follow'`, undici follows the chain INTERNALLY, `fetchBytes` sees one 200, and the
// per-hop containment loop never runs at all — #3431's guard silently reopened with a green suite.
//
// The guard also rests on the other half of that contract: under `manual`, undici must hand back
// the ACTUAL 3xx status with a readable `Location`. The Fetch spec's browser behavior is an
// opaque-redirect filtered response (status 0, no headers), under which the guard would refuse
// every legitimate in-origin redirect instead. Both halves are runtime assumptions about the
// platform, so both are pinned against a real socket here — the same pin, for the same reason, that
// `packages/discovery/transport-http/src/redirect.integration.test.ts` writes for the sibling
// surface.

const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('createBaseSepoliaRecordTransport over a real socket (#3431)', () => {
  it('never reaches the internal host a contained locator redirects to', async () => {
    let internalHits = 0;
    const internal = await serve((_request, response) => {
      internalHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"secret":true}');
    });
    const peer = await serve((_request, response) => {
      response.writeHead(302, { location: `${internal}/latest/meta-data/` });
      response.end();
    });

    const transport = createBaseSepoliaRecordTransport({
      ipfsApiUrl: 'https://ipfs.example.invalid',
      recordOrigins: [`${peer}/records/`],
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    await expect(transport.byLocation(`${peer}/records/abc`))
      .rejects.toBeInstanceOf(NativeRecordDestinationError);
    expect(internalHits).toBe(0);
  });

  it('follows an in-origin redirect, proving undici surfaces a readable 3xx under manual', async () => {
    const bytes = '{"record":"moved"}';
    const peer = await serve((request, response) => {
      if (request.url === '/records/abc') {
        response.writeHead(302, { location: '/records/abc-v2' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(bytes);
    });

    const transport = createBaseSepoliaRecordTransport({
      ipfsApiUrl: 'https://ipfs.example.invalid',
      recordOrigins: [`${peer}/records/`],
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    const fetched = await transport.byLocation(`${peer}/records/abc`);
    expect(new TextDecoder().decode(fetched)).toBe(bytes);
  });
});
