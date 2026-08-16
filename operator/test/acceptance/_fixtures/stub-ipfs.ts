/**
 * Stub IPFS service for acceptance-tier tests.
 *
 * Exposes `startStubIpfs()` which boots an in-process Hono mini-server that
 * mimics the Autonolas IPFS registry + gateway surface:
 *
 *   POST /api/v0/add  — accepts multipart, returns { Hash: '<cid>' }
 *   GET  /ipfs/:cid   — returns previously-pinned bytes
 *
 * CIDs are deterministic: sha256 of the file bytes, hex-prefixed as CIDv1
 * raw (`f01551220<hex>`). This is the same format the real Autonolas registry
 * returns for binary uploads, and matches `buildIpfsHexCidCandidatesFromPartialHex`
 * in `operator/src/adapters/mech/ipfs.ts`.
 *
 * Both `registryUrl` and `gatewayUrl` point at the same server (different
 * URL-path prefixes) so the daemon's IPFS surface round-trips via the same
 * process.
 */

import { createHash } from 'node:crypto';
import { type Server as HttpServer, createServer } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

export interface StubIpfsHandle {
  /** URL for `ipfsRegistryUrl` — points at `/api/v0/add`. */
  registryUrl: string;
  /** URL for `ipfsGatewayUrl` — points at `/ipfs/<cid>`. */
  gatewayUrl: string;
  /** Stop the server and release the port. */
  stop(): Promise<void>;
  /** Test-only: inspect all stored entries. */
  getStored(): Map<string, Buffer>;
}

function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not resolve allocated port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the stub IPFS server on an ephemeral port.
 */
export async function startStubIpfs(): Promise<StubIpfsHandle> {
  const store = new Map<string, Buffer>();
  const app = new Hono();

  /**
   * POST /api/v0/add
   *
   * The daemon calls this via multipart/form-data (same as `pinFileToIpfs`
   * and `uploadToIpfs`). We accept any body and compute a deterministic CID
   * from its sha256 hash.
   */
  app.post('/api/v0/add', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    let bodyBytes: Buffer;

    if (contentType.includes('multipart/form-data')) {
      // Parse multipart to extract the file part.
      const formData = await c.req.formData();
      const file = formData.get('file');
      if (file instanceof File || file instanceof Blob) {
        bodyBytes = Buffer.from(await file.arrayBuffer());
      } else if (typeof file === 'string') {
        bodyBytes = Buffer.from(file, 'utf8');
      } else {
        // Fall back to raw body if no file field.
        bodyBytes = Buffer.from(await c.req.arrayBuffer());
      }
    } else {
      bodyBytes = Buffer.from(await c.req.arrayBuffer());
    }

    const hex = createHash('sha256').update(bodyBytes).digest('hex');
    // CIDv1 raw: multibase prefix `f` + 0155 (version=1, codec=0x55=raw) + 1220 (sha256 multihash) + digest
    const cid = `f01551220${hex}`;
    store.set(cid, bodyBytes);

    return c.text(JSON.stringify({ Hash: cid, Size: bodyBytes.length, Name: '' }) + '\n', 200, {
      'Content-Type': 'application/json',
    });
  });

  /**
   * GET /ipfs/:cid
   *
   * The daemon fetches previously-uploaded content via the gateway URL.
   * We store by full CIDv1 string.
   */
  app.get('/ipfs/:cid', (c) => {
    const cid = c.req.param('cid');
    const buf = store.get(cid);
    if (!buf) return c.text('not found', 404);
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });

  const port = await allocatePort();
  const base = `http://127.0.0.1:${port}`;

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const srv = serve(
      { fetch: app.fetch, port, hostname: '127.0.0.1' },
      () => resolve(srv as HttpServer),
    );
    (srv as HttpServer).on('error', reject);
  });

  return {
    registryUrl: base,
    gatewayUrl: `${base}/ipfs`,
    stop: () =>
      new Promise<void>((res) => {
        (server as HttpServer).close(() => res());
        (server as HttpServer).closeAllConnections?.();
      }),
    getStored: () => store,
  };
}
