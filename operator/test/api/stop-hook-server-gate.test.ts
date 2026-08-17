/**
 * `POST /api/stop-hook` auth gating at the `startApiServer` level (§14.1 of
 * docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md).
 *
 * Route-logic coverage (payload normalization, 400s) lives in
 * `test/api/stop-hook.test.ts` against a bare Hono app. This file exercises
 * the bearer gate + CORS scoping that only exist once the route is mounted
 * through `startApiServer`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';
import type { StopHookPayload } from '../../src/api/stop-hook.js';

const TEST_TOKEN = 'stop-hook-test-token';

let store: Store;
let server: ApiServer | undefined;
let baseUrl: string;
let seen: StopHookPayload[];

beforeEach(async () => {
  store = new Store(':memory:');
  seen = [];
  server = await startApiServer({
    port: 0,
    store,
    apiToken: TEST_TOKEN,
    stopHook: { onStopHook: (payload) => seen.push(payload) },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server?.close();
  store?.close();
});

function payload(): Record<string, unknown> {
  return { tool: 'claude-code', sessionId: 'sess-gate', stoppedAt: '2026-08-04T00:00:00.000Z' };
}

describe('POST /api/stop-hook — auth gate (§14.1)', () => {
  it('rejects an unauthenticated POST → 401, and does NOT ingest the session', async () => {
    const res = await fetch(`${baseUrl}/api/stop-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('rejects a POST with the wrong bearer token → 401', async () => {
    const res = await fetch(`${baseUrl}/api/stop-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('admits a POST with the correct DAEMON_API_TOKEN bearer — the daemon-spawned harness path', async () => {
    const res = await fetch(`${baseUrl}/api/stop-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe('sess-gate');
  });

  it('does not send wildcard CORS headers for /api/stop-hook', async () => {
    const res = await fetch(`${baseUrl}/api/stop-hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify(payload()),
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still sends CORS headers on an unrelated route (e.g. GET /v1/status)', async () => {
    const res = await fetch(`${baseUrl}/v1/status`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBeNull();
  });
});
