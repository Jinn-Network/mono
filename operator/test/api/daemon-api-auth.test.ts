/**
 * Bearer-token middleware coverage for the daemon HTTP API.
 *
 * Exercises the two cost-mutating routes (`POST /v1/artifacts/acquire` and
 * `POST /artifacts`) with no/wrong/correct bearer headers, and verifies a
 * read-only route (`GET /v1/status`) stays public.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §4 + the daemon-API-hardening
 * follow-up that ships with PR-64.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';
import type { Corpus, ArtifactContent } from '../../src/corpus/index.js';

const TEST_TOKEN = 'test-token-123';

let store: Store;
let server: ApiServer | undefined;
let baseUrl: string;

/**
 * Minimal corpus stub — only acquireBySha256 is exercised by the API
 * route, so the other methods throw to flag accidental wider use.
 */
function makeFakeCorpus(): Corpus & { readonly lastHint: unknown } {
  let lastHint: unknown;
  return {
    get lastHint() { return lastHint; },
    async read() { throw new Error('not implemented in test'); },
    async query() { return []; },
    async fetchManifest() { throw new Error('not implemented in test'); },
    async acquire() { throw new Error('not implemented in test'); },
    async acquireBySha256(
      sha256: string,
      _access: Parameters<Corpus['acquireBySha256']>[1],
      hint?: Parameters<Corpus['acquireBySha256']>[2],
    ): Promise<ArtifactContent> {
      lastHint = hint;
      return {
        sha256,
        bytes: Buffer.from('fake-bytes'),
        artifactType: 'design_document',
        source: 'origin',
        paidAmountUsdc: '0',
        fetchedAt: '2026-04-30T00:00:00.000Z',
      };
    },
  };
}

beforeEach(async () => {
  store = new Store(':memory:');
  // port: 0 → OS picks a free port. bindHost defaults to 127.0.0.1.
  // corpus stub registers POST /v1/artifacts/acquire so the route exists
  // and bearer middleware is reachable.
  server = await startApiServer({
    port: 0,
    store,
    apiToken: TEST_TOKEN,
    corpus: makeFakeCorpus(),
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server?.close();
  store?.close();
});

describe('daemon-api-auth (bearer middleware)', () => {
  it('closes promptly with a live events stream', async () => {
    const res = await fetch(`${baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);

    await expect(Promise.race([
      server!.close().then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ])).resolves.toBe('closed');
    server = undefined;
    await res.body?.cancel().catch(() => undefined);
  });

  // ── Unconditional operator-class gate (§14.3) ────────────────────────────
  //
  // The `beforeEach` server above is constructed WITHOUT `ui` — the exact
  // shape `daemon.ts`'s self-start branch (no `config.apiServer`) and other
  // embedded/test callers use. Before the fix, `/v1/events`,
  // `/v1/events/recent`, and `/v1/activity-events` were mounted unconditionally
  // in `startApiServer` but only gated inside the `if (config.ui)` block —
  // so a construction path without `ui` left them world-reachable. These
  // routes must now be gated on EVERY construction path, using the bearer
  // `apiToken` (always present) as the fallback credential.
  it('rejects GET /v1/events with no Authorization header on a bare (no-ui) server → 401', async () => {
    const res = await fetch(`${baseUrl}/v1/events`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string; reason?: string };
    expect(body.error).toBe('unauthorized');
  });

  it('rejects GET /v1/events/recent with no Authorization header on a bare (no-ui) server → 401', async () => {
    const res = await fetch(`${baseUrl}/v1/events/recent`);
    expect(res.status).toBe(401);
  });

  it('rejects GET /v1/activity-events with no Authorization header on a bare (no-ui) server → 401', async () => {
    const res = await fetch(`${baseUrl}/v1/activity-events`);
    expect(res.status).toBe(401);
  });

  it('rejects GET /v1/activity-events/:id with no Authorization header on a bare (no-ui) server → 401', async () => {
    const res = await fetch(`${baseUrl}/v1/activity-events/1`);
    expect(res.status).toBe(401);
  });

  it('admits GET /v1/events/recent with the bearer apiToken on a bare (no-ui) server', async () => {
    const res = await fetch(`${baseUrl}/v1/events/recent`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('admits GET /v1/activity-events with the bearer apiToken on a bare (no-ui) server', async () => {
    const res = await fetch(`${baseUrl}/v1/activity-events`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects POST /v1/artifacts/acquire with no Authorization header → 401', async () => {
    const res = await fetch(`${baseUrl}/v1/artifacts/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sha256: 'a'.repeat(64),
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string; reason?: string };
    expect(body.error).toBe('unauthorized');
    expect(body.reason).toBe('bearer_required');
  });

  it('rejects POST /v1/artifacts/acquire with wrong bearer token → 401', async () => {
    const res = await fetch(`${baseUrl}/v1/artifacts/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({
        sha256: 'a'.repeat(64),
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('admits POST /v1/artifacts/acquire with correct bearer (route now visible)', async () => {
    // Note: the corpus is not configured in this test fixture, so the route
    // is NOT registered and the server returns 404. That still proves the
    // bearer middleware did not 401 us. When corpus IS configured (real
    // daemon) the same call would either 200 (cache/origin hit) or 400
    // (invalid args) — anything but 401 confirms bearer succeeded.
    const res = await fetch(`${baseUrl}/v1/artifacts/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        sha256: 'a'.repeat(64),
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }),
    });
    expect(res.status).not.toBe(401);
  });

  it('passes donated IPFS sources through to corpus.acquireBySha256', async () => {
    const fakeCorpus = makeFakeCorpus() as Corpus & { lastHint?: unknown };
    await server.close();
    store.close();
    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      corpus: fakeCorpus,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const sha256 = 'b'.repeat(64);
    const sources = [{
      kind: 'ipfs',
      cid: 'bafy-donated',
      sha256,
      encoding: 'jinn.artifact.donation.v1',
    }];
    const res = await fetch(`${baseUrl}/v1/artifacts/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        sha256,
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
        artifactType: 'design_document',
        envelopeCid: 'bafyEnv',
        sources,
      }),
    });

    expect(res.status).toBe(200);
    expect(fakeCorpus.lastHint).toMatchObject({
      artifactType: 'design_document',
      envelopeCid: 'bafyEnv',
      sources,
    });
  });

  it('rejects donated IPFS sources that point at a different sha256', async () => {
    const sha256 = 'b'.repeat(64);
    const res = await fetch(`${baseUrl}/v1/artifacts/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        sha256,
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
        sources: [{
          kind: 'ipfs',
          cid: 'bafy-donated',
          sha256: 'c'.repeat(64),
          encoding: 'jinn.artifact.donation.v1',
        }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { reason?: string; error?: string };
    expect(body.reason).toBe('invalid_args');
    expect(body.error).toMatch(/source sha256/i);
  });

  it('rejects malformed donated IPFS sources with actionable invalid_args response', async () => {
    const sha256 = 'b'.repeat(64);
    const res = await fetch(`${baseUrl}/v1/artifacts/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        sha256,
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
        sources: [{
          kind: 'http',
          cid: 'https://example.com/not-ipfs',
          sha256,
          encoding: 'plain',
        }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { reason?: string; error?: string; retryable?: boolean };
    expect(body.reason).toBe('invalid_args');
    expect(body.retryable).toBe(false);
    expect(body.error).toMatch(/sources must be donation IPFS artifact source objects/i);
  });

  it('rejects POST /artifacts with no Authorization header → 401', async () => {
    const res = await fetch(`${baseUrl}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'unauthenticated',
        content: 'should be rejected',
        tags: ['auth-test'],
        outcome: 'UNKNOWN',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('admits POST /artifacts with correct bearer (insert succeeds)', async () => {
    const res = await fetch(`${baseUrl}/artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        title: 'authenticated post',
        content: 'should be accepted',
        tags: ['auth-test'],
        outcome: 'SUCCESS',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { published?: boolean };
    expect(body.published).toBe(true);
  });

  // §14.5 (issue #2404): `/v1/status` lost its auth exemption once
  // `/health` + `/ready` landed as the unauthenticated-safe liveness
  // surface. The `beforeEach` server above has no `ui` configured, so
  // `requireOperatorToken` falls back to the bearer `apiToken` — same
  // credential every other gated route on a bare/test server uses.
  it('rejects GET /v1/status with no Authorization header on a bare (no-ui) server → 401', async () => {
    const res = await fetch(`${baseUrl}/v1/status`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('unauthorized');
  });

  it('admits GET /v1/status with the bearer apiToken on a bare (no-ui) server', async () => {
    const res = await fetch(`${baseUrl}/v1/status`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('GET /health stays public (no token required)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  it('GET /ready stays public (no token required)', async () => {
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
  });

  it('GET /metrics stays public (no token required)', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
  });

  it('requires the UI token before retrying agent binding', async () => {
    await server.close();
    store.close();

    let retryCalls = 0;
    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
      agentBinding: {
        listUnbound: async () => [{ serviceIndex: 0 }],
        retryBind: async (serviceIndex) => {
          retryCalls += 1;
          return { serviceIndex, status: 'queued' };
        },
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const unauthenticated = await fetch(`${baseUrl}/v1/setup/agent-binding/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceIndex: 0 }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(retryCalls).toBe(0);

    const authenticated = await fetch(`${baseUrl}/v1/setup/agent-binding/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-jinn-ui-token': 'ui-token',
      },
      body: JSON.stringify({ serviceIndex: 0 }),
    });
    expect(authenticated.status).toBe(200);
    expect(retryCalls).toBe(1);
  });

  it('requires the UI token for operator-class bootstrap, events, and artifacts routes', async () => {
    await server.close();
    store.close();

    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-ui-auth-'));
    writeFileSync(join(earningDir, 'earning_state.json'), JSON.stringify({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    }));
    const configPath = join(earningDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      operator: {
        publicEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
      },
    }));

    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
      bootstrap: { earningDir },
      operatorArtifacts: {
        configPath,
        operatorConfig: {
          publicEndpoint: 'https://op.example.com',
          defaultPriceUsdc: '0',
          perArtifactTypePrice: {},
          donation: { enabled: false },
        },
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    for (const path of ['/v1/bootstrap', '/v1/events/recent', '/v1/operator/artifacts']) {
      const unauthenticated = await fetch(`${baseUrl}${path}`);
      expect(unauthenticated.status).toBe(401);

      const authenticated = await fetch(`${baseUrl}${path}`, {
        headers: { 'x-jinn-ui-token': 'ui-token' },
      });
      expect(authenticated.status).toBe(200);
    }
  });

  it('rejects the bearer apiToken ALONE on an operator-class route when ui IS configured — the two credential planes do not merge', async () => {
    // §4.2's disposition table scopes the bearer `apiToken` to
    // `/artifacts` + `/v1/artifacts/acquire` + the stop-hook compat path
    // ONLY. `apiToken` sits in every spawned solver agent's own process env
    // (learner adapters' spawnOpts.env, Hermes' bootstrap .env file) — any
    // agent with a shell can read it. Admitting it on `Control`-class
    // operator routes (setup, admin, claim-policy, captures, ...) would let
    // any agent reach change-password, restart/stop, real-money faucet
    // drip, etc. When `config.ui` is configured (every production boot via
    // main.ts), ONLY the ui-token grants access here — this is an
    // empirical regression for that finding, not a design restatement.
    await server.close();
    store.close();

    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const bearerOnly = await fetch(`${baseUrl}/v1/events/recent`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(bearerOnly.status).toBe(401);

    // Sanity: the ui-token still admits on the same server/route.
    const uiTokenAuthed = await fetch(`${baseUrl}/v1/events/recent`, {
      headers: { 'x-jinn-ui-token': 'ui-token' },
    });
    expect(uiTokenAuthed.status).toBe(200);
  });

  it('GET /v1/operator/claim-policy is 404 when ui is set but claimPolicy routes are not wired', async () => {
    await server.close();
    store.close();

    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const missing = await fetch(`${baseUrl}/v1/operator/claim-policy`, {
      headers: { 'x-jinn-ui-token': 'ui-token' },
    });
    expect(missing.status).toBe(404);
  });

  it('GET /v1/operator/claim-policy is 200 when claimPolicy is wired', async () => {
    await server.close();
    store.close();

    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
      claimPolicy: {
        configPath: '/tmp/jinn-claim-policy-test.json',
        readConfig: () =>
          ({
            claimPolicy: { mode: 'claim-nothing' },
            executionWiring: [],
          }) as never,
        writeConfig: () => undefined,
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const ok = await fetch(`${baseUrl}/v1/operator/claim-policy`, {
      headers: { 'x-jinn-ui-token': 'ui-token' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      claimPolicy: { mode: 'claim-nothing' },
      executionWiring: [],
      restartRequired: false,
    });
  });

  it('GET /v1/operator/claim-policy is 200 when claimPolicy is unset on the config', async () => {
    await server.close();
    store.close();

    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: TEST_TOKEN,
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
      claimPolicy: {
        configPath: '/tmp/jinn-claim-policy-unset.json',
        readConfig: () => ({}) as never,
        writeConfig: () => undefined,
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const ok = await fetch(`${baseUrl}/v1/operator/claim-policy`, {
      headers: { 'x-jinn-ui-token': 'ui-token' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      executionWiring: [],
      restartRequired: false,
    });
  });
});
