/**
 * Server-mount wiring for GET /v1/harnesses/auth-status (#564).
 *
 * Asserts the route is mounted by startApiServer when a
 * harnessReadinessRegistry is supplied, and that it sits behind the existing
 * `/v1/harnesses/*` UI-token gate (same gate as the readiness endpoint).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';
import type { Harness } from '../../src/harnesses/types.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'auth-status-wiring-')), 'jinn.db'));
}

const UI_TOKEN = 'ui-token-564';

function fixtureHarness(): Harness {
  return {
    name: 'hermes-agent',
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    getAuthSource: async () => ({ sourceKind: 'session', docAnchor: 'claude-code' }),
  };
}

describe('startApiServer — /v1/harnesses/auth-status wiring (#564)', () => {
  let store: Store;
  let server: ApiServer;
  afterEach(async () => {
    await server?.close();
    store?.close();
  });

  it('mounts the route behind the UI-token gate when a registry is provided', async () => {
    store = freshStore();
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'hermes-agent': fixtureHarness() },
      joinedHarnessesByCid: {},
    });
    server = await startApiServer({
      port: 0,
      store,
      apiToken: 't',
      ui: { token: UI_TOKEN, handshakeKey: 'hk' },
      harnessReadinessRegistry: registry,
    });

    // Gated: no token → 401.
    const unauth = await fetch(`http://127.0.0.1:${server.port}/v1/harnesses/auth-status`);
    expect(unauth.status).toBe(401);

    // With the UI token → 200 + harnesses array.
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/harnesses/auth-status`, {
      headers: { 'x-jinn-ui-token': UI_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { harnesses: unknown[] };
    expect(Array.isArray(body.harnesses)).toBe(true);
    expect(body.harnesses).toHaveLength(1);
  });
});
