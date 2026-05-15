import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { fetchFromIpfs } from '../../src/adapters/mech/ipfs.js';
import { uploadArtifacts } from '../../src/harnesses/engine/packaging.js';

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function parseMultipartJson(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('multipart upload did not contain JSON');
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

describe('donation IPFS adapter smoke', () => {
  let server: Server;
  let baseUrl: string;
  let store: Store;
  let tmp: string;
  const ipfs = new Map<string, unknown>();

  beforeEach(async () => {
    store = new Store(':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'jinn-donation-http-smoke-'));
    ipfs.clear();
    server = createServer((req, res) => {
      void (async () => {
        try {
          if (req.method === 'POST' && req.url?.startsWith('/api/v0/add')) {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const payload = parseMultipartJson(Buffer.concat(chunks));
            const digest = sha256Hex(Buffer.from(JSON.stringify(payload), 'utf8'));
            const cid = `bafy${digest.slice(0, 52)}`;
            ipfs.set(cid, payload);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ Name: 'content.json', Hash: cid, Size: '1' }) + '\n');
            return;
          }

          if (req.method === 'GET' && req.url?.startsWith('/ipfs/')) {
            const cid = decodeURIComponent(req.url.slice('/ipfs/'.length));
            if (!ipfs.has(cid)) {
              res.writeHead(404, { 'content-type': 'text/plain' });
              res.end('not found');
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(ipfs.get(cid)));
            return;
          }

          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(err instanceof Error ? err.stack ?? err.message : String(err));
        }
      })();
    });
    const port = await listen(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    await close(server);
  });

  it('pins a scrubbed donation wrapper through the real IPFS adapter shape and fetches it back', async () => {
    const file = join(tmp, 'artifact.json');
    writeFileSync(file, JSON.stringify({
      message: 'operator adriano on devbox',
      path: '/Users/adriano/project/out.json',
      apiToken: 'secret-value',
    }));

    const [artifact] = await uploadArtifacts(
      [{ localPath: file, artifactType: 'output.portfolio.v0' }],
      {
        store,
        operatorEndpoint: 'https://operator.example.com',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        requestId: '0x' + 'd'.repeat(64),
        donation: {
          enabled: true,
          ipfsRegistryUrl: baseUrl,
          scrub: {
            identity: { username: 'adriano', hostname: 'devbox' },
            path: { home: '/Users/adriano' },
          },
        },
      },
    );

    expect(artifact?.sources?.[0]?.kind).toBe('ipfs');
    const source = artifact!.sources![0]!;
    const wrapper = await fetchFromIpfs(baseUrl, source.cid) as Record<string, unknown>;
    expect(wrapper.schemaVersion).toBe('jinn.artifact.donation.v1');
    expect(wrapper.sha256).toBe(source.sha256);
    const bytes = Buffer.from(wrapper.data as string, 'base64');
    const json = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(json.message).toBe('operator <USER> on <HOST>');
    expect(json.path).toBe('/users/anon/project/out.json');
    expect(json.apiToken).toBe('<REDACTED>');
    expect(sha256Hex(bytes)).toBe(source.sha256);
    expect(store.getServedArtifact(source.sha256)?.content.equals(bytes)).toBe(true);
  });
});
