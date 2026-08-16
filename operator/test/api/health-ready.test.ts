/**
 * `GET /health` + `GET /ready` (spec/2026-08-04-headless-operator-rederivation-design.md
 * §6.1, §14.5; issue #2404).
 *
 * Both routes are ungated; `/ready`'s status/reason mapping is the load-bearing contract —
 * see the parameterized table below. `getDaemonReadiness` is injected via `ApiServerConfig`
 * (api→daemon architecture boundary, #1584 — `operator/src/api/` must never import
 * `operator/src/daemon/`; this test file is NOT under `src/api/`, so it can import the real
 * shared holder from `daemon/loop-heartbeat.js` and wire it straight through).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';
import { getDaemonReadiness, setDaemonReadiness } from '../../src/daemon/loop-heartbeat.js';
import { buildEnvelope } from '../../src/errors/envelope.js';
import { persistBootstrapError } from '../../src/errors/persisted-bootstrap-error.js';

const TEST_TOKEN = 'test-token-456';

let store: Store;
let server: ApiServer | undefined;
let baseUrl: string;

beforeEach(async () => {
  store = new Store(':memory:');
  server = await startApiServer({ port: 0, store, apiToken: TEST_TOKEN, getDaemonReadiness });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server?.close();
  store?.close();
  setDaemonReadiness('ready');
});

describe('GET /health', () => {
  it('always returns 200 { ok: true }, unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('never requires a token even when the server has ui configured', async () => {
    await server!.close();
    store.close();
    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

describe('GET /ready — the §6.1 status/reason mapping', () => {
  const cases: Array<{
    readiness: 'ready' | 'degraded' | 'bootstrapping';
    expectedStatus: number;
    expectedAcceptingWork: boolean;
  }> = [
    { readiness: 'ready', expectedStatus: 200, expectedAcceptingWork: true },
    { readiness: 'degraded', expectedStatus: 200, expectedAcceptingWork: false },
    { readiness: 'bootstrapping', expectedStatus: 503, expectedAcceptingWork: false },
  ];

  it.each(cases)(
    'readiness=$readiness → HTTP $expectedStatus, reason=$readiness, accepting_work=$expectedAcceptingWork',
    async ({ readiness, expectedStatus, expectedAcceptingWork }) => {
      setDaemonReadiness(readiness);
      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(expectedStatus);
      const body = (await res.json()) as { reason: string; accepting_work: boolean };
      expect(body.reason).toBe(readiness);
      expect(body.accepting_work).toBe(expectedAcceptingWork);
    },
  );

  it('defaults to ready (200) when getDaemonReadiness is not wired at all (bare/test server)', async () => {
    await server!.close();
    store.close();
    store = new Store(':memory:');
    server = await startApiServer({ port: 0, store, apiToken: TEST_TOKEN });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('ready');
  });

  it('never requires a token even when the server has ui configured', async () => {
    await server!.close();
    store.close();
    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
  });

  it('carries no cause when degraded and no bootstrap config is wired (bare/test server)', async () => {
    setDaemonReadiness('degraded');
    const res = await fetch(`${baseUrl}/ready`);
    const body = (await res.json()) as { cause?: string };
    expect(body.cause).toBeUndefined();
  });

  it('surfaces the persisted bootstrap-halt envelope code as `cause` when degraded', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-ready-cause-'));
    writeFileSync(join(earningDir, 'earning_state.json'), JSON.stringify({ services: [] }));
    persistBootstrapError(
      buildEnvelope({ code: 'funding_required', message: 'master EOA under-funded' }),
      earningDir,
    );

    await server!.close();
    store.close();
    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      bootstrap: { earningDir },
      getDaemonReadiness,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    setDaemonReadiness('degraded');
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reason: string; cause?: string };
    expect(body.reason).toBe('degraded');
    expect(body.cause).toBe('funding_required');
  });
});
