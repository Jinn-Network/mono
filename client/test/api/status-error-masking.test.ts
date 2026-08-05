/**
 * GET /v1/status 500-handler masking (spec §14.2 item 2, issue #2402).
 *
 * Before the #2402 fix, `/v1/status`'s catch-all error handler returned
 * `err.message` verbatim (leaking an embedded RPC URL / key-in-path) and
 * `daemon.dbPath` (an absolute filesystem path). This covers the case where
 * an exception escapes gather-status.ts's own internal masking
 * (defense-in-depth for the server boundary itself). `/v1/status` is
 * operator-class as of spec §14.5 (issue #2404); the fetch below carries
 * the bearer token this bare (no-`ui`) server accepts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { startApiServer, type ApiServer } from '../../src/api/server.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'status-error-masking-')), 'jinn.db'));
}

describe('GET /v1/status error-response masking', () => {
  let store: Store;
  let server: ApiServer;

  afterEach(async () => {
    await server?.close();
    store?.close();
    vi.restoreAllMocks();
  });

  it('masks a URL-bearing error and drops the SQLite file path on 500', async () => {
    store = freshStore();
    const leakyMessage =
      'HTTP request failed.\n\nURL: https://base-mainnet.g.alchemy.com/v2/SECRETKEY123\nDetails: fetch failed';
    // Note: NOT getShutdownState — the catch block itself reads that to
    // build `daemon.shutdownState`, so mocking it to always throw would
    // re-throw out of the catch handler too. getActivityCountsByKind is read
    // early in gatherGatheredStatusRaw but never touched by the error path.
    vi.spyOn(store, 'getActivityCountsByKind').mockImplementation(() => {
      throw new Error(leakyMessage);
    });

    server = await startApiServer({ port: 0, store, apiToken: 't' });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/status`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as {
      error: string;
      message: string;
      daemon: Record<string, unknown>;
    };

    expect(res.status).toBe(500);
    expect(body.error).toBe('status_gather_failed');
    expect(body.message).toContain('base-mainnet.g.alchemy.com');
    expect(body.message).not.toContain('SECRETKEY123');
    expect(body.daemon).not.toHaveProperty('dbPath');
    expect(JSON.stringify(body)).not.toContain('SECRETKEY123');
    expect(JSON.stringify(body)).not.toContain(store.path);
  });
});
