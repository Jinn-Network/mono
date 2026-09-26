/**
 * Tests for the one-click operator debug-report endpoints (issue #420 §2).
 *
 * `GET /v1/debug-report/manifest` describes the bundle; `POST /v1/debug-report`
 * assembles and streams the .tar.gz. The decompress-and-grep-for-planted-
 * secrets assertion is the binding end-to-end redaction gate.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { gunzipSync } from 'node:zlib';
import { Store } from '../../src/store/store.js';
import { addDebugReportRoutes } from '../../src/api/debug-report-endpoint.js';
import { readTarEntries } from '../../src/observability/tar.js';

let stores: Store[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function memoryStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

function depsFor(store: Store) {
  return {
    store,
    config: {
      network: 'testnet' as const,
      rpcUrl: 'https://rpc.example.com/v3/PLANTEDrpcKeySegment0001',
      dbPath: '/home/user/.jinn-client/jinn.db',
      earningDir: '/home/user/.jinn-client/earning',
      ui: { token: 'PLANTED-ui-token-value', handshakeKey: 'PLANTED-handshake-value' },
    } as never,
    configPath: '/home/user/.jinn-client/config.json',
  };
}

describe('GET /v1/debug-report/manifest', () => {
  it('returns the bundle file list and a redaction summary', async () => {
    const app = new Hono();
    addDebugReportRoutes(app, depsFor(memoryStore()));
    const res = await app.request('/v1/debug-report/manifest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: string[]; redaction: unknown };
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files).toContain('status.json');
    expect(body.files).toContain('config.json');
    expect(body.files).toContain('redaction-report.md');
    expect(body.redaction).toBeTruthy();
  });
});

describe('POST /v1/debug-report', () => {
  it('returns a gzip attachment with a dated filename', async () => {
    const app = new Hono();
    addDebugReportRoutes(app, depsFor(memoryStore()));
    const res = await app.request('/v1/debug-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/gzip');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/attachment/);
    expect(disposition).toMatch(/jinn-debug-report-.*\.tar\.gz/);
  });

  it('produces a tar.gz that decompresses to the expected file set', async () => {
    const store = memoryStore();
    store.recordActivityEvent({
      ts: '2026-05-20T00:00:00Z',
      kind: 'startup',
      requestId: null,
      serviceIndex: null,
      txHash: null,
      solverType: null,
      outcome: 'ok',
      detail: 'daemon started',
    });
    const app = new Hono();
    addDebugReportRoutes(app, depsFor(store));
    const res = await app.request('/v1/debug-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const entries = readTarEntries(gunzipSync(buf));
    const names = entries.map((e) => e.name.split('/').slice(1).join('/'));
    expect(names).toContain('status.json');
    expect(names).toContain('config.json');
    expect(names).toContain('config-provenance.json');
    expect(names).toContain('activity-events.json');
    expect(names).toContain('redaction-report.md');
    expect(names).toContain('bundle-meta.json');
  });

  it('includes the dashboard screenshot when one is posted', async () => {
    const app = new Hono();
    addDebugReportRoutes(app, depsFor(memoryStore()));
    // 1x1 transparent PNG.
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const res = await app.request('/v1/debug-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screenshotPngBase64: pngBase64 }),
    });
    const entries = readTarEntries(gunzipSync(Buffer.from(await res.arrayBuffer())));
    expect(entries.some((e) => e.name.endsWith('dashboard-screenshot.png'))).toBe(true);
    expect(entries.some((e) => e.name.endsWith('screenshot-unavailable.txt'))).toBe(false);
  });

  it('emits screenshot-unavailable.txt when no screenshot is posted', async () => {
    const app = new Hono();
    addDebugReportRoutes(app, depsFor(memoryStore()));
    const res = await app.request('/v1/debug-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const entries = readTarEntries(gunzipSync(Buffer.from(await res.arrayBuffer())));
    expect(entries.some((e) => e.name.endsWith('screenshot-unavailable.txt'))).toBe(true);
  });

  it('SECURITY: no planted secret survives anywhere in the decompressed bundle', async () => {
    const store = memoryStore();
    // Plant a private-key-shaped secret inside an activity event detail.
    store.recordActivityEvent({
      ts: '2026-05-20T00:00:00Z',
      kind: 'tick_error',
      requestId: null,
      serviceIndex: null,
      txHash: null,
      solverType: null,
      outcome: 'failed',
      detail: 'crashed with key 0x' + 'bd'.repeat(32),
    });
    const app = new Hono();
    addDebugReportRoutes(app, depsFor(store));
    const res = await app.request('/v1/debug-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const tar = gunzipSync(Buffer.from(await res.arrayBuffer())).toString('latin1');
    // Config-level secrets from depsFor().
    expect(tar).not.toContain('PLANTED-ui-token-value');
    expect(tar).not.toContain('PLANTED-handshake-value');
    expect(tar).not.toContain('PLANTEDrpcKeySegment0001');
    // Private-key-shaped value planted in the activity event.
    expect(tar).not.toContain('0x' + 'bd'.repeat(32));
    // RPC hostname is intentionally KEPT.
    expect(tar).toContain('rpc.example.com');
  });

  it('handles an empty / missing request body without throwing', async () => {
    const app = new Hono();
    addDebugReportRoutes(app, depsFor(memoryStore()));
    const res = await app.request('/v1/debug-report', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

/**
 * Pins the catch path that writes `status.message` from a thrown gather
 * error. The route does not mask at the catch — `assembleDebugReport` runs
 * `redactValue` over the payload — so this is the bundle dialect, not
 * `sanitizeErrorText`. Isolated from the rest of the file via resetModules
 * + doMock so the top-level route import is left alone.
 */
describe('POST /v1/debug-report status.json gather failure (#4248)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/api/gather-status.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('keeps the RPC host and strips the key-in-path from status.message', async () => {
    const host = 'base-mainnet.paid-provider.example';
    const secret = 'SUPERSECRETKEY1234567';
    vi.resetModules();
    vi.doMock('../../src/api/gather-status.js', () => ({
      gatherStatusForApi: async () => {
        throw new Error(`HTTP request failed. URL: https://${host}/v2/${secret}`);
      },
    }));
    const { addDebugReportRoutes: addRoutes } = await import('../../src/api/debug-report-endpoint.js');
    const app = new Hono();
    addRoutes(app, depsFor(memoryStore()));
    const res = await app.request('/v1/debug-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const entries = readTarEntries(gunzipSync(Buffer.from(await res.arrayBuffer())));
    const statusEntry = entries.find((e) => e.name.endsWith('status.json'));
    expect(statusEntry).toBeDefined();
    const statusJson = JSON.parse(statusEntry!.content.toString('utf8')) as {
      error?: string;
      message?: string;
    };
    expect(JSON.stringify(statusJson)).not.toContain(secret);
    expect(statusJson.message).toContain(host);
  });
});
