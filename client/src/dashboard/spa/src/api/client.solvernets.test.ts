/**
 * Shape tests for the new `api.solvernets.*` namespace.
 *
 * Each test mocks `fetch`, calls one method, then asserts the URL + method +
 * body the client produced. The point is to lock in the wire shape — Tasks
 * 18 and 19 will rely on these methods making the right requests.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client.js';

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: CapturedCall[];

beforeEach(() => {
  calls = [];
  // Default fetch mock returns an empty JSON object so the client's `res.json()`
  // resolves; tests that need a specific shape override this per-call.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lastCall(): CapturedCall {
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]!;
}

describe('api.solvernets — drafts CRUD', () => {
  it('listDrafts: GET /v1/solvernets/drafts', async () => {
    await api.solvernets.listDrafts();
    expect(lastCall().url).toBe('/v1/solvernets/drafts');
    expect(lastCall().init?.method).toBeUndefined(); // GET is the default
  });

  it('getDraft: GET /v1/solvernets/drafts/:id', async () => {
    await api.solvernets.getDraft('draft_abc');
    expect(lastCall().url).toBe('/v1/solvernets/drafts/draft_abc');
  });

  it('createDraft: POST /v1/solvernets/drafts with the body', async () => {
    await api.solvernets.createDraft({ name: 'X' });
    const c = lastCall();
    expect(c.url).toBe('/v1/solvernets/drafts');
    expect(c.init?.method).toBe('POST');
    expect(JSON.parse(c.init!.body as string)).toEqual({ name: 'X' });
  });

  it('createDraft with no body sends an empty object', async () => {
    await api.solvernets.createDraft();
    expect(JSON.parse(lastCall().init!.body as string)).toEqual({});
  });

  it('updateDraft: PATCH /v1/solvernets/drafts/:id with the patch', async () => {
    await api.solvernets.updateDraft('draft_abc', { description: 'hi' });
    const c = lastCall();
    expect(c.url).toBe('/v1/solvernets/drafts/draft_abc');
    expect(c.init?.method).toBe('PATCH');
    expect(JSON.parse(c.init!.body as string)).toEqual({ description: 'hi' });
  });

  it('deleteDraft: DELETE /v1/solvernets/drafts/:id', async () => {
    await api.solvernets.deleteDraft('draft_abc');
    expect(lastCall().url).toBe('/v1/solvernets/drafts/draft_abc');
    expect(lastCall().init?.method).toBe('DELETE');
  });
});

describe('api.solvernets — launch + lifecycle', () => {
  it('launch: POST /v1/solvernets/drafts/:id/launch', async () => {
    await api.solvernets.launch('draft_abc');
    const c = lastCall();
    expect(c.url).toBe('/v1/solvernets/drafts/draft_abc/launch');
    expect(c.init?.method).toBe('POST');
  });

  it('transitionLifecycle: PATCH /v1/solvernets/launched/:id/lifecycle', async () => {
    await api.solvernets.transitionLifecycle('snid', 'paused');
    const c = lastCall();
    expect(c.url).toBe('/v1/solvernets/launched/snid/lifecycle');
    expect(c.init?.method).toBe('PATCH');
    expect(JSON.parse(c.init!.body as string)).toEqual({ target: 'paused' });
  });

  it('updateGeneratorConfig: PATCH /v1/solvernets/launched/:id/generator-config', async () => {
    await api.solvernets.updateGeneratorConfig('snid', { cadenceMs: 60_000 });
    const c = lastCall();
    expect(c.url).toBe('/v1/solvernets/launched/snid/generator-config');
    expect(c.init?.method).toBe('PATCH');
    expect(JSON.parse(c.init!.body as string)).toEqual({ cadenceMs: 60_000 });
  });
});

describe('api.solvernets — owned launched + registry', () => {
  it('get: GET /v1/solvernets/launched/:id', async () => {
    await api.solvernets.get('snid');
    expect(lastCall().url).toBe('/v1/solvernets/launched/snid');
  });

  it('listLaunched: GET /v1/solvernets/launched (no filter)', async () => {
    await api.solvernets.listLaunched();
    expect(lastCall().url).toBe('/v1/solvernets/launched');
  });

  it('listLaunched with status: appends ?status=...', async () => {
    await api.solvernets.listLaunched({ status: 'launched' });
    expect(lastCall().url).toBe('/v1/solvernets/launched?status=launched');
  });

  it('listRegistry: GET /v1/solvernets/registry (no opts)', async () => {
    await api.solvernets.listRegistry();
    expect(lastCall().url).toBe('/v1/solvernets/registry');
  });

  it('listRegistry with status + refresh: appends both query params', async () => {
    await api.solvernets.listRegistry({ status: 'launched', refresh: true });
    expect(lastCall().url).toBe('/v1/solvernets/registry?status=launched&refresh=1');
  });

  it('getManifest: GET /v1/solvernets/registry/:cid', async () => {
    await api.solvernets.getManifest('QmXyz12345abcdef');
    expect(lastCall().url).toBe('/v1/solvernets/registry/QmXyz12345abcdef');
  });
});

describe('api.operator — artifact store', () => {
  it('listArtifacts: GET /v1/operator/execution-data with source and limit', async () => {
    await api.operator.listArtifacts({ source: 'network', limit: 25 });
    expect(lastCall().url).toBe('/v1/operator/execution-data?source=network&limit=25');
  });

  it('updatePricing: POST /v1/operator/pricing with full pricing config', async () => {
    await api.operator.updatePricing({
      publicEndpoint: 'https://op.example.com',
      defaultPriceUsdc: '0.001',
      perArtifactTypePrice: { design_document: '0.01' },
      donation: { enabled: true },
    });
    const c = lastCall();
    expect(c.url).toBe('/v1/operator/pricing');
    expect(c.init?.method).toBe('POST');
    expect(JSON.parse(c.init!.body as string)).toEqual({
      publicEndpoint: 'https://op.example.com',
      defaultPriceUsdc: '0.001',
      perArtifactTypePrice: { design_document: '0.01' },
      donation: { enabled: true },
    });
  });
});
