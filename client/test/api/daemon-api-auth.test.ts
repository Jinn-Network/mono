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
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';
import type { Corpus, ArtifactContent } from '../../src/corpus/index.js';

const TEST_TOKEN = 'test-token-123';

let store: Store;
let server: ApiServer;
let baseUrl: string;

/**
 * Minimal corpus stub — only acquireBySha256 is exercised by the API
 * route, so the other methods throw to flag accidental wider use.
 */
function makeFakeCorpus(): Corpus {
  return {
    async read() { throw new Error('not implemented in test'); },
    async query() { return []; },
    async fetchManifest() { throw new Error('not implemented in test'); },
    async acquire() { throw new Error('not implemented in test'); },
    async acquireBySha256(sha256: string): Promise<ArtifactContent> {
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
  await server.close();
  store.close();
});

describe('daemon-api-auth (bearer middleware)', () => {
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

  it('GET /v1/status stays public (no bearer required)', async () => {
    const res = await fetch(`${baseUrl}/v1/status`);
    expect(res.status).toBe(200);
  });
});
