import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createStatusServer } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import type { EnrichmentRunner } from '../src/runner.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://user:secret@db.internal:5432/jinn',
  DATABASE_SCHEMA: 'jinn_indexer_v1',
});

function fakeRunner(ready: boolean): EnrichmentRunner {
  return {
    getStatus: () => ({
      ready,
      startedAt: new Date().toISOString(),
      lastError: null,
      ticks: 3,
      discovered: 10,
      enriched: 8,
      retried: 1,
      failedFetch: 1,
    }),
  } as unknown as EnrichmentRunner;
}

let server: import('node:http').Server;
let base: string;

async function listen(ready: boolean): Promise<void> {
  server = createStatusServer({ config, runner: fakeRunner(ready) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}

afterEach(() => {
  server?.close();
});

describe('status server', () => {
  it('GET /health always returns 200', async () => {
    await listen(false);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /ready returns 503 before ready, 200 after', async () => {
    await listen(false);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    server.close();
    await listen(true);
    expect((await fetch(`${base}/ready`)).status).toBe(200);
  });

  it('GET /status returns the redacted config + batch stats, never the raw URL', async () => {
    await listen(true);
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats.enriched).toBe(8);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body.config.databaseSchema).toBe('jinn_indexer_v1');
  });

  it('unknown path returns 404', async () => {
    await listen(true);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
