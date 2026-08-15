import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { postToDaemon } from '../../src/cli/daemon-control-client.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

function makeTokenFile(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-daemon-control-client-'));
  const path = join(dir, 'ui-token');
  writeFileSync(path, `${token}\n`);
  return path;
}

describe('postToDaemon', () => {
  it('reports unreachable when nothing is listening on the port', async () => {
    const result = await postToDaemon({ apiPort: 1, path: '/v1/setup/bootstrap/retry', timeoutMs: 300 });
    expect(result.reachable).toBe(false);
  });

  it('sends the x-jinn-ui-token header when a token file is present', async () => {
    let receivedHeader: string | undefined;
    server = createServer((req, res) => {
      receivedHeader = req.headers['x-jinn-ui-token'] as string | undefined;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server!.address() as AddressInfo).port;
    const tokenPath = makeTokenFile('secret-token-value');

    const result = await postToDaemon<{ ok: boolean }>({
      apiPort: port,
      path: '/v1/setup/bootstrap/retry',
      tokenPath,
    });

    expect(result.reachable).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(receivedHeader).toBe('secret-token-value');
  });

  it('omits the header when no token file exists', async () => {
    let receivedHeader: string | undefined = 'unset';
    server = createServer((req, res) => {
      receivedHeader = req.headers['x-jinn-ui-token'] as string | undefined;
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server!.address() as AddressInfo).port;

    await postToDaemon({
      apiPort: port,
      path: '/v1/setup/bootstrap/retry',
      tokenPath: join(mkdtempSync(join(tmpdir(), 'jinn-no-token-')), 'ui-token'),
    });

    expect(receivedHeader).toBeUndefined();
  });

  it('surfaces a non-2xx status with the parsed body', async () => {
    server = createServer((req, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'daemon_not_halted' }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server!.address() as AddressInfo).port;

    const result = await postToDaemon<{ ok: boolean; error: string }>({
      apiPort: port,
      path: '/v1/setup/bootstrap/retry',
      tokenPath: join(mkdtempSync(join(tmpdir(), 'jinn-500-')), 'ui-token'),
    });

    expect(result.reachable).toBe(true);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ ok: false, error: 'daemon_not_halted' });
  });
});
