/**
 * SolverNet drafts CRUD + launch/lifecycle/generator-config endpoint tests
 * (Tasks 13 and 14).
 *
 * Spec: spec/2026-05-05-solvernet-creation-and-launch.md §6.1, §10.
 *
 * Each test stands up a fresh Hono app + tmpdir-backed SolverNet store and
 * exercises the route through `app.request(...)`. Auth wiring matches the
 * launcher-endpoints pattern: `requireUiToken` middleware in front, callers
 * supply `x-jinn-ui-token`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Hono } from 'hono';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  registerSolverNetsEndpoints,
  type SolverNetsEndpointsDeps,
} from '../../src/api/solvernets-endpoints.js';
import type { LauncherGeneratorStateSnapshot } from '../../src/api/launcher-status.js';
import { requireUiToken } from '../../src/api/handshake.js';
import {
  createSolverNetStore,
  type LaunchedSolverNetRecord,
  type SolverNetStore,
} from '../../src/solvernets/store.js';
import {
  LaunchAction,
  type LaunchActionDeps,
} from '../../src/solvernets/launch-state-machine.js';
import { manifestHash } from '../../src/solvernets/manifest.js';
import type {
  PendingGeneratorSpawn,
  SolverNetCatalogCache,
} from '../../src/solvernets/daemon-init.js';
import type {
  IpfsClient,
  MetadataPublisher,
  SetMetadataPublishResult,
  SubgraphClient,
} from '../../src/solvernets/registry-client-erc8004.js';
import type {
  SignerWithAgentEoa,
  SolverNetManifestSummary,
  SolverNetRegistryClient,
} from '../../src/solvernets/registry-client.js';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';
import type { PredictionV1GeneratorRuntimeConfig } from '../../src/solver-types/prediction-v1-auto.js';

const UI_TOKEN = 'ui-token-test';

interface BuildArgs {
  store: SolverNetStore;
  withAuth?: boolean;
  // Optional Task 14 deps. When omitted, only the Task 13 (drafts) endpoints
  // are exercised.
  launch?: SolverNetsEndpointsDeps['launch'];
  // Optional Task 15 deps for the registry catalog endpoints.
  catalog?: SolverNetsEndpointsDeps['catalog'];
  registry?: SolverNetsEndpointsDeps['registry'];
}

function buildTestApp(args: BuildArgs): { app: Hono; token: string } {
  const app = new Hono();
  if (args.withAuth ?? true) {
    app.use('/v1/solvernets/drafts', requireUiToken(UI_TOKEN));
    app.use('/v1/solvernets/drafts/*', requireUiToken(UI_TOKEN));
    app.use('/v1/solvernets/launched', requireUiToken(UI_TOKEN));
    app.use('/v1/solvernets/launched/*', requireUiToken(UI_TOKEN));
    app.use('/v1/solvernets/registry', requireUiToken(UI_TOKEN));
    app.use('/v1/solvernets/registry/*', requireUiToken(UI_TOKEN));
  }
  const deps: SolverNetsEndpointsDeps = { store: args.store };
  if (args.launch !== undefined) deps.launch = args.launch;
  if (args.catalog !== undefined) deps.catalog = args.catalog;
  if (args.registry !== undefined) deps.registry = args.registry;
  registerSolverNetsEndpoints(app, deps);
  return { app, token: UI_TOKEN };
}

let baseDir: string;
let store: SolverNetStore;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'solvernet-endpoints-'));
  store = createSolverNetStore({ baseDir });
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const authHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  'x-jinn-ui-token': UI_TOKEN,
});

describe('POST /v1/solvernets/drafts', () => {
  it('creates an empty draft with auto-generated draftId', async () => {
    const { app, token } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jinn-ui-token': token },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draftId: string;
      schemaVersion: string;
      completedSteps: string[];
      createdAt: string;
      updatedAt: string;
    };
    expect(body.draftId).toMatch(/.+/);
    expect(body.schemaVersion).toBe('solvernet.draft.v1');
    expect(body.completedSteps).toEqual([]);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.updatedAt).toBe(body.createdAt);

    // Persisted on disk, listable, loadable.
    const drafts = await store.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.draftId).toBe(body.draftId);
  });

  it('creates a draft with no body at all', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draftId: string };
    expect(body.draftId).toMatch(/.+/);
  });

  it('persists fields supplied in the create body', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'My Net',
        description: 'a description',
        templateContractId: 'prediction-v1',
        templateContractVersion: '1.0.0',
        solutionPriceWei: '1000000000000000000',
        openRoles: ['solver'],
        completedSteps: ['define'],
        generatorConfig: { cadenceMs: 60000 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draftId: string;
      name: string;
      description: string;
      templateContractId: string;
      templateContractVersion: string;
      solutionPriceWei: string;
      openRoles: string[];
      completedSteps: string[];
      generatorConfig: Record<string, unknown>;
    };
    expect(body.name).toBe('My Net');
    expect(body.description).toBe('a description');
    expect(body.templateContractId).toBe('prediction-v1');
    expect(body.templateContractVersion).toBe('1.0.0');
    expect(body.solutionPriceWei).toBe('1000000000000000000');
    expect(body.openRoles).toEqual(['solver']);
    expect(body.completedSteps).toEqual(['define']);
    expect(body.generatorConfig).toEqual({ cadenceMs: 60000 });

    // Round-trip on disk.
    const loaded = await store.loadDraft(body.draftId);
    expect(loaded?.name).toBe('My Net');
  });

  it('rejects body with wrong field types', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'POST',
      headers: authHeaders(),
      // `name` must be a string, not a number
      body: JSON.stringify({ name: 42 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_body');
    expect(body.message).toMatch(/.+/);

    // Nothing persisted.
    expect(await store.listDrafts()).toEqual([]);
  });

  it('rejects body with invalid openRoles enum value', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ openRoles: ['launcher'] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('rejects malformed JSON', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'POST',
      headers: authHeaders(),
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('requires auth', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/solvernets/drafts/:id', () => {
  it('returns the persisted draft', async () => {
    const { app } = buildTestApp({ store });
    // Seed via POST so we have a real draftId.
    const created = (await (
      await app.request('/v1/solvernets/drafts', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'orig' }),
      })
    ).json()) as { draftId: string };

    const res = await app.request(`/v1/solvernets/drafts/${created.draftId}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draftId: string; name: string };
    expect(body.draftId).toBe(created.draftId);
    expect(body.name).toBe('orig');
  });

  it('returns 404 for unknown draft id', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts/draft_does_not_exist', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('draft_not_found');
  });
});

describe('PATCH /v1/solvernets/drafts/:id', () => {
  it('updates supplied fields and preserves others', async () => {
    const { app } = buildTestApp({ store });
    const created = (await (
      await app.request('/v1/solvernets/drafts', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'orig', description: 'keep me' }),
      })
    ).json()) as { draftId: string; createdAt: string };

    // Wait a millisecond so updatedAt observably moves.
    await new Promise((r) => setTimeout(r, 5));

    const res = await app.request(`/v1/solvernets/drafts/${created.draftId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'updated', solutionPriceWei: '42' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draftId: string;
      name: string;
      description: string;
      solutionPriceWei: string;
      createdAt: string;
      updatedAt: string;
    };
    expect(body.draftId).toBe(created.draftId);
    expect(body.name).toBe('updated');
    expect(body.description).toBe('keep me');
    expect(body.solutionPriceWei).toBe('42');
    // createdAt unchanged, updatedAt moved.
    expect(body.createdAt).toBe(created.createdAt);
    expect(body.updatedAt).not.toBe(created.createdAt);

    // Disk state matches.
    const loaded = await store.loadDraft(created.draftId);
    expect(loaded?.name).toBe('updated');
    expect(loaded?.description).toBe('keep me');
  });

  it('rejects attempts to change draftId or createdAt (immutable fields)', async () => {
    const { app } = buildTestApp({ store });
    const created = (await (
      await app.request('/v1/solvernets/drafts', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'orig' }),
      })
    ).json()) as { draftId: string; createdAt: string };

    const res = await app.request(`/v1/solvernets/drafts/${created.draftId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ draftId: 'evil_id' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_body');
    expect(body.message).toMatch(/draftId/);

    // Disk state unchanged.
    const loaded = await store.loadDraft(created.draftId);
    expect(loaded?.draftId).toBe(created.draftId);
    expect(loaded?.name).toBe('orig');
  });

  it('returns 404 for unknown draft id', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts/draft_unknown', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'whatever' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('draft_not_found');
  });

  it('rejects body with wrong field types', async () => {
    const { app } = buildTestApp({ store });
    const created = (await (
      await app.request('/v1/solvernets/drafts', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      })
    ).json()) as { draftId: string };

    const res = await app.request(`/v1/solvernets/drafts/${created.draftId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ openRoles: ['not-a-real-role'] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const { app } = buildTestApp({ store });
    const created = (await (
      await app.request('/v1/solvernets/drafts', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      })
    ).json()) as { draftId: string };

    const res = await app.request(`/v1/solvernets/drafts/${created.draftId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: '{nope',
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /v1/solvernets/drafts/:id', () => {
  it('deletes a draft and subsequent GET returns 404', async () => {
    const { app } = buildTestApp({ store });
    const created = (await (
      await app.request('/v1/solvernets/drafts', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      })
    ).json()) as { draftId: string };

    const delRes = await app.request(`/v1/solvernets/drafts/${created.draftId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);

    const getRes = await app.request(`/v1/solvernets/drafts/${created.draftId}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(404);
  });

  it('returns 404 for unknown draft id', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts/draft_missing', {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('draft_not_found');
  });
});

describe('GET /v1/solvernets/drafts', () => {
  it('returns an empty array when there are no drafts', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drafts: unknown[] };
    expect(body.drafts).toEqual([]);
  });

  it('returns all owned drafts', async () => {
    const { app } = buildTestApp({ store });
    // Seed three drafts.
    for (const name of ['a', 'b', 'c']) {
      await app.request('/v1/solvernets/drafts', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name }),
      });
    }

    const res = await app.request('/v1/solvernets/drafts', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drafts: Array<{ name?: string }> };
    expect(body.drafts).toHaveLength(3);
    expect(body.drafts.map((d) => d.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('requires auth', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/drafts', {
      method: 'GET',
      // No token.
      headers: {},
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 14 — launch / lifecycle / generator-config / launched-record GET
// ─────────────────────────────────────────────────────────────────────────────

interface MockIpfs extends IpfsClient {
  uploadCalls: number;
}

function makeMockIpfs(): MockIpfs {
  let uploadCalls = 0;
  const uploads = new Map<string, unknown>();
  function cidOf(data: unknown): string {
    const json = JSON.stringify(data);
    let h = 0;
    for (const ch of json) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `bafy-test-${h.toString(16).padStart(8, '0')}`;
  }
  return {
    async upload(data) {
      uploadCalls += 1;
      const cid = cidOf(data);
      uploads.set(cid, data);
      return cid;
    },
    async fetch(cid) {
      const found = uploads.get(cid);
      if (found === undefined) throw new Error(`mock ipfs: cid not found ${cid}`);
      return found;
    },
    get uploadCalls() {
      return uploadCalls;
    },
  };
}

interface MockPublisher extends MetadataPublisher {
  calls: Array<{ key: string; value: Uint8Array }>;
}

function makeMockPublisher(): MockPublisher {
  const calls: Array<{ key: string; value: Uint8Array }> = [];
  let nextBlock = 100;
  return {
    async setMetadata(args): Promise<SetMetadataPublishResult> {
      calls.push({ key: args.key, value: args.value });
      return {
        txHash: `0x${'aa'.repeat(31)}${calls.length.toString(16).padStart(2, '0')}` as `0x${string}`,
        blockNumber: nextBlock++,
      };
    },
    get calls() {
      return calls;
    },
  };
}

function makeNoopSubgraph(): SubgraphClient {
  return {
    async fetchSetMetadataEvents() {
      return [];
    },
    async fetchSetMetadataEventsForCid() {
      return [];
    },
  };
}

interface MockRegistry extends SolverNetRegistryClient {
  publishLifecycleCalls: Array<{
    manifestCid: string;
    target: 'launched' | 'paused' | 'retired';
  }>;
}

function makeMockRegistry(): MockRegistry {
  const publishLifecycleCalls: Array<{
    manifestCid: string;
    target: 'launched' | 'paused' | 'retired';
  }> = [];
  let nextBlock = 200;
  return {
    async publishManifest() {
      throw new Error('publishManifest not used in API tests (LaunchAction handles it)');
    },
    async publishLifecycleTransition(args) {
      publishLifecycleCalls.push({ manifestCid: args.manifestCid, target: args.target });
      return {
        metadataTxHash: `0x${'bb'.repeat(31)}${publishLifecycleCalls.length
          .toString(16)
          .padStart(2, '0')}` as `0x${string}`,
        metadataBlockNumber: nextBlock++,
      };
    },
    async listLaunched() {
      return [];
    },
    async getManifest() {
      throw new Error('not used');
    },
    async getManifestFromCache() {
      // Default test registry behaves as a cold cache — Task 14 lifecycle
      // and launch tests don't exercise the summary-enrichment path.
      return null;
    },
    async getLifecycleStatus() {
      throw new Error('not used');
    },
    get publishLifecycleCalls() {
      return publishLifecycleCalls;
    },
  };
}

interface ConfirmHelper {
  awaitTxConfirmation: (txHash: `0x${string}`) => Promise<{ blockNumber: number }>;
  confirms: Array<`0x${string}`>;
}

function makeConfirmHelper(): ConfirmHelper {
  const confirms: Array<`0x${string}`> = [];
  let nextBlock = 300;
  return {
    confirms,
    async awaitTxConfirmation(txHash) {
      confirms.push(txHash);
      return { blockNumber: nextBlock++ };
    },
  };
}

/**
 * Build a complete launch dep bundle around a real `LaunchAction` instance
 * backed by the test mocks. The lifecycle-transition producer retired with
 * Wave-4 D3, so no `LifecycleTransition` is wired here. Mirrors the
 * production wiring in `daemon-init.ts` minus the in-memory pendingGenerators
 * — we manage those directly so tests can assert on configRef mutation.
 */
function makeLaunchDeps(args: {
  store: SolverNetStore;
  pendingGenerators: { current: PendingGeneratorSpawn[] };
  signer?: SignerWithAgentEoa;
  spawnGenerator?: (record: LaunchedSolverNetRecord) => Promise<void>;
  startGenerator?: (record: LaunchedSolverNetRecord) => Promise<void>;
  stopGenerator?: (record: LaunchedSolverNetRecord) => Promise<void>;
  publisher?: MetadataPublisher;
}): {
  launch: SolverNetsEndpointsDeps['launch'];
  ipfs: MockIpfs;
  publisher: MetadataPublisher;
  subgraph: SubgraphClient;
  registry: MockRegistry;
  signer: SignerWithAgentEoa;
} {
  const ipfs = makeMockIpfs();
  const publisher = args.publisher ?? makeMockPublisher();
  const subgraph = makeNoopSubgraph();
  const registry = makeMockRegistry();
  const confirm = makeConfirmHelper();

  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  const signer: SignerWithAgentEoa = args.signer ?? {
    agentEoaAddress: acct.address,
    agentEoaPrivateKey: pk,
    agentId: '5474',
  };

  const launchDeps: LaunchActionDeps = {
    store: args.store,
    ipfs,
    publisher,
    subgraph,
    awaitTxConfirmation: confirm.awaitTxConfirmation,
    spawnGenerator: args.spawnGenerator ?? (async () => undefined),
    now: () => new Date('2026-05-06T00:00:00.000Z'),
  };
  const launchAction = new LaunchAction(launchDeps);

  return {
    launch: {
      launchAction,
      pendingGenerators: args.pendingGenerators,
      signer,
      network: 'base-sepolia',
      launcher: {
        safeAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        agentEoa: signer.agentEoaAddress,
        agentId: signer.agentId,
      },
      now: () => new Date('2026-05-06T00:00:00.000Z'),
    },
    ipfs,
    publisher,
    subgraph,
    registry,
    signer,
  };
}

/**
 * Seed a fully-launchable draft via the API and return its draftId.
 */
async function seedLaunchableDraft(
  app: Hono,
): Promise<string> {
  const res = await app.request('/v1/solvernets/drafts', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      name: 'Prediction Markets — Test',
      description: 'A test SolverNet for launch endpoint tests.',
      templateContractId: 'prediction',
      templateContractVersion: 'v1',
      solutionPriceWei: '1000000000000000',
      verdictPriceWei: '500000000000000',
      openRoles: ['solver', 'evaluator'],
      generatorConfig: { cadenceMs: 60000 },
      completedSteps: ['define', 'reviewContract', 'configureGenerator', 'configurePricing'],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { draftId: string };
  return body.draftId;
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 1000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== null && result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

describe('POST /v1/solvernets/drafts/:id/launch (Task 14)', () => {
  it('happy path: launches draft → record on disk, 202 with pollUrl, GET returns record', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    const draftId = await seedLaunchableDraft(app);

    const res = await app.request(`/v1/solvernets/drafts/${draftId}/launch`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      solverNetId: string;
      status: string;
      pollUrl: string;
    };
    expect(body.solverNetId).toMatch(/.+/);
    expect(body.pollUrl).toBe(`/v1/solvernets/launched/${body.solverNetId}`);

    // Wait for background launch to complete: state machine eventually flips
    // status to 'launched'.
    const launched = await waitFor(async () => {
      const r = await store.loadRecord(body.solverNetId);
      return r?.status === 'launched' ? r : null;
    });
    expect(launched.solverNetId).toBe(body.solverNetId);
    expect(launched.manifestCid).toMatch(/^bafy-test-/);

    // Subsequent GET returns the record.
    const getRes = await app.request(body.pollUrl, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as LaunchedSolverNetRecord;
    expect(getBody.solverNetId).toBe(body.solverNetId);
    expect(getBody.status).toBe('launched');
  });

  it('rejects launch on a draft missing required fields with 400 + missingFields', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    // Draft with only name set — missing description, prices, openRoles, template.
    const create = (await (
      await app.request('/v1/solvernets/drafts', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'incomplete' }),
      })
    ).json()) as { draftId: string };

    const res = await app.request(`/v1/solvernets/drafts/${create.draftId}/launch`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      missingFields: string[];
    };
    expect(body.error).toBe('draft_incomplete');
    expect(body.missingFields).toEqual(
      expect.arrayContaining([
        'description',
        'templateContractId',
        'templateContractVersion',
        'solutionPriceWei',
        'verdictPriceWei',
        'openRoles',
      ]),
    );
  });

  it('rejects launch on unknown draft id with 404', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    const res = await app.request('/v1/solvernets/drafts/draft_does_not_exist/launch', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('draft_not_found');
  });

  it('returns 503 when launch deps are not configured', async () => {
    const { app } = buildTestApp({ store });

    const draftId = await seedLaunchableDraft(app);

    const res = await app.request(`/v1/solvernets/drafts/${draftId}/launch`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('launch_unavailable');
  });
});

describe('PATCH /v1/solvernets/launched/:id/generator-config (Task 14)', () => {
  it('updates configRef.current AND the record on disk; subsequent GET reflects it', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    // Seed launched record + corresponding pendingGenerator entry.
    const draftId = await seedLaunchableDraft(app);
    const launchRes = await app.request(`/v1/solvernets/drafts/${draftId}/launch`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const launchBody = (await launchRes.json()) as { solverNetId: string };
    const launched = await waitFor(async () => {
      const r = await store.loadRecord(launchBody.solverNetId);
      return r?.status === 'launched' ? r : null;
    });

    // Construct a pendingGenerators entry mirroring what daemon-init.ts
    // would produce. The endpoint mutates configRef.current in place.
    const recordRef = { current: launched };
    const configRef = {
      current: { cadenceMs: 60000 } as PredictionV1GeneratorRuntimeConfig,
    };
    pendingGenerators.current.push({ record: launched, recordRef, configRef });

    const res = await app.request(
      `/v1/solvernets/launched/${launched.solverNetId}/generator-config`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({
          cadenceMs: 30000,
          maxNewRoundsPerPoll: 7,
          allowlistConditionIds: ['0xabc'],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PredictionV1GeneratorRuntimeConfig;
    expect(body.cadenceMs).toBe(30000);
    expect(body.maxNewRoundsPerPoll).toBe(7);
    expect(body.allowlistConditionIds).toEqual(['0xabc']);

    // Hot-apply: configRef mutated in place.
    expect(configRef.current.cadenceMs).toBe(30000);
    expect(configRef.current.maxNewRoundsPerPoll).toBe(7);
    expect(configRef.current.allowlistConditionIds).toEqual(['0xabc']);

    // Disk persistence on the launched record.
    const onDisk = await store.loadRecord(launched.solverNetId);
    expect(onDisk?.generatorConfig).toEqual({
      cadenceMs: 30000,
      maxNewRoundsPerPoll: 7,
      allowlistConditionIds: ['0xabc'],
    });

    // Subsequent GET reflects the on-disk record.
    const getRes = await app.request(`/v1/solvernets/launched/${launched.solverNetId}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    const getBody = (await getRes.json()) as LaunchedSolverNetRecord;
    expect(getBody.generatorConfig).toEqual({
      cadenceMs: 30000,
      maxNewRoundsPerPoll: 7,
      allowlistConditionIds: ['0xabc'],
    });
  });

  it('updates record on disk even when no pendingGenerator entry exists (paused records)', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    // Seed launched record without adding to pendingGenerators (mirrors a
    // paused record where the daemon stopped the generator).
    const draftId = await seedLaunchableDraft(app);
    const launchRes = await app.request(`/v1/solvernets/drafts/${draftId}/launch`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const launchBody = (await launchRes.json()) as { solverNetId: string };
    const launched = await waitFor(async () => {
      const r = await store.loadRecord(launchBody.solverNetId);
      return r?.status === 'launched' ? r : null;
    });

    const res = await app.request(
      `/v1/solvernets/launched/${launched.solverNetId}/generator-config`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ cadenceMs: 12345 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PredictionV1GeneratorRuntimeConfig;
    expect(body.cadenceMs).toBe(12345);

    const onDisk = await store.loadRecord(launched.solverNetId);
    expect(onDisk?.generatorConfig).toEqual({ cadenceMs: 12345 });
  });

  it('accepts swe-rebench-v2 generator config keys and hot-applies them', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });
    const launched: LaunchedSolverNetRecord = {
      ...makeOwnedRecord({
        solverNetId: '5474_swe-rebench-v2-v1_edb172d3',
        status: 'paused',
      }),
      generatorEnabled: true,
      generatorConfig: {
        N_target_successes: 5,
        N_max_postings_per_task: 15,
        cooldown_ms: 86_400_000,
        claimPolicy: {
          maxClaims: 50,
          maxClaimsPerOperator: 5,
          claimLeaseTtlSeconds: 3_600,
        },
      },
    };
    await store.writeRecord(launched);
    const recordRef = { current: launched };
    const configRef = { current: launched.generatorConfig };
    pendingGenerators.current.push({ record: launched, recordRef, configRef });

    const res = await app.request(
      `/v1/solvernets/launched/${launched.solverNetId}/generator-config`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({
          cooldown_ms: 300_000,
          claimPolicy: {
            maxClaims: 10,
            claimLeaseTtlSeconds: 1_800,
          },
        }),
      },
    );

    expect(res.status).toBe(200);
    // #802: N_max_postings_per_task is dropped on canonical write (abandon cap removed).
    expect(await res.json()).toEqual({
      N_target_successes: 5,
      maxClaimsPerOperator: 5,
      claimLeaseTtlSeconds: 1_800,
    });
    expect(configRef.current).toEqual({
      N_target_successes: 5,
      maxClaimsPerOperator: 5,
      claimLeaseTtlSeconds: 1_800,
    });
    const onDisk = await store.loadRecord(launched.solverNetId);
    expect(onDisk?.generatorConfig).toEqual({
      N_target_successes: 5,
      maxClaimsPerOperator: 5,
      claimLeaseTtlSeconds: 1_800,
    });
  });

  it('uses the manifest contract before solverNetId when validating generator config patches', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });
    const solverNetId = 'legacy-swe-record';
    const cid = 'bafylegacyswemanifest1234567890';
    const baseManifest = makeManifest({ solverNetId, manifestCid: cid });
    const sweManifest: SolverNetManifestV1 = {
      ...baseManifest,
      contract: {
        ...baseManifest.contract,
        id: 'swe-rebench-v2',
        version: 'v1',
      },
    };
    const manifestPath = await store.writeManifestCache(cid, sweManifest);
    const launched: LaunchedSolverNetRecord = {
      ...makeOwnedRecord({ solverNetId, status: 'paused' }),
      manifestCid: cid,
      manifestHash: manifestHash(sweManifest),
      manifestPath,
      generatorEnabled: true,
      generatorConfig: {
        N_target_successes: 5,
        N_max_postings_per_task: 15,
        cooldown_ms: 86_400_000,
      },
    };
    await store.writeRecord(launched);

    const res = await app.request(
      `/v1/solvernets/launched/${launched.solverNetId}/generator-config`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ cooldown_ms: 300_000 }),
      },
    );

    expect(res.status).toBe(200);
    // #802: N_max_postings_per_task is dropped on canonical write (abandon cap removed).
    expect(await res.json()).toEqual({
      N_target_successes: 5,
    });
  });

  it('tolerates legacy swe-rebench-v2 claimPolicy.maxClaims and normalizes it away', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });
    const launched: LaunchedSolverNetRecord = {
      ...makeOwnedRecord({
        solverNetId: '5474_swe-rebench-v2-v1_edb172d3',
        status: 'paused',
      }),
      generatorEnabled: true,
      generatorConfig: {
        N_target_successes: 5,
        N_max_postings_per_task: 15,
        cooldown_ms: 86_400_000,
      },
    };
    await store.writeRecord(launched);

    const res = await app.request(
      `/v1/solvernets/launched/${launched.solverNetId}/generator-config`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({
          claimPolicy: {
            maxClaims: 3,
            maxClaimsPerOperator: 4,
            claimLeaseTtlSeconds: 1_800,
          },
        }),
      },
    );

    expect(res.status).toBe(200);
    // #802: N_max_postings_per_task is dropped on canonical write (abandon cap removed).
    expect(await res.json()).toEqual({
      N_target_successes: 5,
      maxClaimsPerOperator: 4,
      claimLeaseTtlSeconds: 1_800,
    });
  });

  it('drops the legacy N_max_postings_per_task cap on canonical write (#802)', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });
    const launched: LaunchedSolverNetRecord = {
      ...makeOwnedRecord({
        solverNetId: '5474_swe-rebench-v2-v1_edb172d3',
        status: 'paused',
      }),
      generatorEnabled: true,
      generatorConfig: {
        N_target_successes: 5,
        N_max_postings_per_task: 15,
        cooldown_ms: 86_400_000,
      },
    };
    await store.writeRecord(launched);

    // The abandon cap is gone: bumping N_target_successes above the old cap is
    // now allowed, and the dead N_max_postings_per_task key is dropped on write.
    const res = await app.request(
      `/v1/solvernets/launched/${launched.solverNetId}/generator-config`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ N_target_successes: 20 }),
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ N_target_successes: 20 });
    const onDisk = await store.loadRecord(launched.solverNetId);
    expect(onDisk?.generatorConfig).toEqual({ N_target_successes: 20 });
  });

  it('rejects prediction-shaped patches for swe-rebench-v2 records with schema issues', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });
    const launched: LaunchedSolverNetRecord = {
      ...makeOwnedRecord({
        solverNetId: '5474_swe-rebench-v2-v1_edb172d3',
        status: 'paused',
      }),
      generatorEnabled: true,
      generatorConfig: {
        N_target_successes: 5,
        N_max_postings_per_task: 15,
        cooldown_ms: 86_400_000,
      },
    };
    await store.writeRecord(launched);

    const res = await app.request(
      `/v1/solvernets/launched/${launched.solverNetId}/generator-config`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ cadenceMs: 60_000, maxOpenRounds: 3 }),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      kind?: string;
      issues?: Array<{ message: string }>;
    };
    expect(body.kind).toBe('schema_validation_failed');
    expect(body.issues?.some((issue) => issue.message.includes('cadenceMs'))).toBe(true);
  });

  it('rejects unknown record id with 404', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    const res = await app.request(
      '/v1/solvernets/launched/no-such-record/generator-config',
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ cadenceMs: 1000 }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('rejects body with invalid field types', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    const draftId = await seedLaunchableDraft(app);
    const launchRes = await app.request(`/v1/solvernets/drafts/${draftId}/launch`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const { solverNetId } = (await launchRes.json()) as { solverNetId: string };
    await waitFor(async () => {
      const r = await store.loadRecord(solverNetId);
      return r?.status === 'launched' ? r : null;
    });

    const res = await app.request(
      `/v1/solvernets/launched/${solverNetId}/generator-config`,
      {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ cadenceMs: 'fast' }),
      },
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/solvernets/launched/:id (Task 14)', () => {
  it('returns the persisted launched record', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    const draftId = await seedLaunchableDraft(app);
    const launchRes = await app.request(`/v1/solvernets/drafts/${draftId}/launch`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const { solverNetId } = (await launchRes.json()) as { solverNetId: string };
    await waitFor(async () => {
      const r = await store.loadRecord(solverNetId);
      return r?.status === 'launched' ? r : null;
    });

    const res = await app.request(`/v1/solvernets/launched/${solverNetId}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LaunchedSolverNetRecord;
    expect(body.solverNetId).toBe(solverNetId);
    expect(body.status).toBe('launched');
    expect(body.manifestCid).toMatch(/.+/);
  });

  it('returns 404 for unknown record id', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    const res = await app.request('/v1/solvernets/launched/missing-id', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('requires auth', async () => {
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const { app } = buildTestApp({ store, launch: launchBundle.launch });

    const res = await app.request('/v1/solvernets/launched/anything', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  it('overlays live generatorState on single-record and list responses', async () => {
    const persistedState = {
      lastPollAt: '2026-05-06T00:00:00.000Z',
      lastError: { message: 'persisted failure', at: '2026-05-06T00:01:00.000Z' },
    };
    const liveState: LauncherGeneratorStateSnapshot = {
      cadenceMs: 120000,
      lastPollAt: '2026-05-06T00:10:00.000Z',
      lastPollSummary: { evaluated: 8, posted: 2, skipped: 6 },
    };
    const record: LaunchedSolverNetRecord = {
      ...makeOwnedRecord({ solverNetId: 'rec-live', status: 'launched' }),
      generatorState: persistedState,
    };
    const pendingGenerators = {
      current: [
        {
          record,
          recordRef: { current: record },
          configRef: { current: {} as PredictionV1GeneratorRuntimeConfig },
        },
      ] as PendingGeneratorSpawn[],
    };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const launch = {
      ...launchBundle.launch!,
      getGeneratorState: (solverNetId: string) =>
        solverNetId === 'rec-live' ? liveState : undefined,
    } as SolverNetsEndpointsDeps['launch'];
    const { app } = buildTestApp({ store, launch });
    await store.writeRecord(record);

    const singleRes = await app.request(`/v1/solvernets/launched/${record.solverNetId}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(singleRes.status).toBe(200);
    const singleBody = (await singleRes.json()) as LaunchedSolverNetRecord;
    expect(singleBody.generatorState).toEqual(liveState);

    const listRes = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { records: LaunchedSolverNetRecord[] };
    expect(listBody.records).toHaveLength(1);
    expect(listBody.records[0]?.generatorState).toEqual(liveState);
  });

  it('falls back to persisted generatorState when no live generator snapshot exists', async () => {
    const persistedState = {
      lastPollAt: '2026-05-06T00:00:00.000Z',
      lastError: { message: 'persisted failure', at: '2026-05-06T00:01:00.000Z' },
    };
    const record: LaunchedSolverNetRecord = {
      ...makeOwnedRecord({ solverNetId: 'rec-persisted', status: 'launched' }),
      generatorState: persistedState,
    };
    const pendingGenerators = { current: [] as PendingGeneratorSpawn[] };
    const launchBundle = makeLaunchDeps({ store, pendingGenerators });
    const launch = {
      ...launchBundle.launch!,
      getGeneratorState: () => undefined,
    } as SolverNetsEndpointsDeps['launch'];
    const { app } = buildTestApp({ store, launch });
    await store.writeRecord(record);

    const singleRes = await app.request(`/v1/solvernets/launched/${record.solverNetId}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(singleRes.status).toBe(200);
    const singleBody = (await singleRes.json()) as LaunchedSolverNetRecord;
    expect(singleBody.generatorState).toEqual(persistedState);

    const listRes = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { records: LaunchedSolverNetRecord[] };
    expect(listBody.records).toHaveLength(1);
    expect(listBody.records[0]?.generatorState).toEqual(persistedState);
  });

  // ── Summary enrichment (follow-up .35) ──────────────────────────────────

  it('embeds `summary` on the single-record response when the cache has the manifest', async () => {
    const record = makeOwnedRecord({ solverNetId: 'rec-1', status: 'launched' });
    const manifest = makeManifest({
      solverNetId: 'rec-1',
      manifestCid: record.manifestCid,
    });
    manifest.name = 'Single Net';
    const registry = makeMockRegistryGet({
      manifests: new Map([[record.manifestCid, manifest]]),
    });
    const { app } = buildTestApp({ store, registry });
    await store.writeRecord(record);

    const res = await app.request(`/v1/solvernets/launched/${record.solverNetId}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LaunchedSolverNetRecord & {
      summary?: SolverNetManifestSummary;
    };
    expect(body.solverNetId).toBe('rec-1');
    expect(body.summary).toBeDefined();
    expect(body.summary?.name).toBe('Single Net');
    expect(body.summary?.contractId).toBe('prediction');
    expect(body.summary?.contractVersion).toBe('v1');
    expect(body.summary?.openRoles).toEqual(['solver', 'evaluator']);
  });

  it('omits `summary` on the single-record response when the cache misses', async () => {
    const record = makeOwnedRecord({ solverNetId: 'rec-cold', status: 'launched' });
    const registry = makeMockRegistryGet({});
    const { app } = buildTestApp({ store, registry });
    await store.writeRecord(record);

    const res = await app.request(`/v1/solvernets/launched/${record.solverNetId}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LaunchedSolverNetRecord & {
      summary?: SolverNetManifestSummary;
    };
    expect(body.solverNetId).toBe('rec-cold');
    expect(body.summary).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 15 — owned-list + global-registry catalog endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal `LaunchedSolverNetRecord` directly without going through the
 * launch state machine — useful when the test only cares about disk records,
 * not the full launch flow. The record satisfies the store schema; manifestCid
 * and statusUpdatedAt are derived from `args.solverNetId` for stability.
 */
function makeOwnedRecord(args: {
  solverNetId: string;
  status: 'launching' | 'launched' | 'paused' | 'retired' | 'failed';
}): LaunchedSolverNetRecord {
  const at = '2026-05-06T00:00:00.000Z';
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: args.solverNetId,
    manifestCid: `bafy-test-${args.solverNetId}`,
    manifestHash: `0x${'aa'.repeat(32)}`,
    launcherAgentId: '5474',
    launcherSafeAddress: '0x1111111111111111111111111111111111111111',
    launchedAt: at,
    status: args.status,
    statusUpdatedAt: at,
    generatorEnabled: args.status === 'launched',
    registry: {
      metadataTxHash: `0x${'bb'.repeat(32)}`,
      metadataBlockNumber: 100,
    },
  };
}

/**
 * Mockable `SolverNetCatalogCache` for Task 15 tests. Exposes the same surface
 * as the real cache from `daemon-init.ts`; refresh() is a noop unless the test
 * supplies a `refreshHandler`.
 */
type MockCatalogError = { message: string; at: Date; code?: 'rpc_rate_limited' };

interface MockCatalog extends SolverNetCatalogCache {
  refreshCalls: number;
  setSnapshot: (snapshot: SolverNetManifestSummary[]) => void;
  setError: (err: MockCatalogError | null) => void;
  setLastRefreshedAt: (at: Date | null) => void;
}

function makeMockCatalog(initial: {
  snapshot?: SolverNetManifestSummary[];
  lastRefreshedAt?: Date | null;
  lastError?: MockCatalogError | null;
  refreshHandler?: () => Promise<void>;
} = {}): MockCatalog {
  let snapshot: SolverNetManifestSummary[] = initial.snapshot ?? [];
  let lastRefreshedAt: Date | null = initial.lastRefreshedAt ?? null;
  let lastError: MockCatalogError | null = initial.lastError ?? null;
  let refreshCalls = 0;
  const refreshHandler = initial.refreshHandler;

  return {
    getCatalog: () => snapshot,
    async refresh() {
      refreshCalls += 1;
      if (refreshHandler) await refreshHandler();
    },
    stop() {},
    lastRefreshedAt: () => lastRefreshedAt,
    lastError: () => lastError,
    get refreshCalls() {
      return refreshCalls;
    },
    setSnapshot(next) {
      snapshot = next;
    },
    setError(next) {
      lastError = next;
    },
    setLastRefreshedAt(next) {
      lastRefreshedAt = next;
    },
  };
}

/**
 * Build a deterministic `SolverNetManifestSummary` for catalog tests.
 */
function makeSummary(args: {
  solverNetId: string;
  manifestCid?: string;
  status: 'launched' | 'paused' | 'retired';
  name?: string;
}): SolverNetManifestSummary {
  return {
    manifestCid: args.manifestCid ?? `bafy-${args.solverNetId}`,
    solverNetId: args.solverNetId,
    name: args.name ?? args.solverNetId,
    network: 'base-sepolia',
    launcherAgentId: '5474',
    launcherSafeAddress: '0x1111111111111111111111111111111111111111',
    status: args.status,
    statusUpdatedAt: '2026-05-06T00:00:00.000Z',
    contractId: 'prediction',
    contractVersion: 'v1',
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
    anchorBlock: 200,
  };
}

/**
 * Build a deterministic `SolverNetManifestV1`. Used when stubbing
 * `registry.getManifest` for /registry/:cid tests; only the shape needs to be
 * close enough — we are not exercising the manifest schema validator here.
 *
 * Cast through `unknown` because we only build the subset of fields the
 * endpoint forwards as its response — schema completeness is the registry
 * client's job.
 */
function makeManifest(args: {
  solverNetId: string;
  manifestCid?: string;
}): SolverNetManifestV1 {
  return {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: args.solverNetId,
    network: 'base-sepolia',
    name: args.solverNetId,
    description: 'test manifest',
    launcher: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
      agentId: '5474',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: { task: {}, solution: {}, verdict: {} },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 10,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      credentialRequirements: { creator: [], solver: [], evaluator: [] },
      evaluationFunction: {
        id: 'prediction.brier-loss.v1',
        deterministic: true,
        inputs: ['solution', 'resolution'],
        output: 'verdict',
        implementation: 'jinn:harness:prediction-v1-evaluator',
      },
      aggregationFunction: {
        id: 'prediction.trailing-mean-brier-spread.v1',
        deterministic: true,
        inputs: ['verdict[]'],
        output: 'score',
        windowDays: 30,
      },
    },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
    ...(args.manifestCid ? { registry: { manifestCid: args.manifestCid } } : {}),
    createdAt: '2026-05-06T00:00:00.000Z',
    launchedAt: '2026-05-06T00:00:00.000Z',
    signature: {
      alg: 'eip-191',
      signer: '0x2222222222222222222222222222222222222222',
      value: `0x${'cc'.repeat(65)}`,
    },
  };
}

/**
 * Mockable `SolverNetRegistryClient` for Task 15. Only `getManifest` and
 * `getLifecycleStatus` are populated — the catalog endpoints lean on
 * `deps.catalog` for list/refresh, not the registry directly.
 */
interface MockRegistryGet extends SolverNetRegistryClient {
  getManifestCalls: string[];
}

function makeMockRegistryGet(args: {
  manifests?: Map<string, SolverNetManifestV1>;
  lifecycleStatuses?: Map<
    string,
    { status: 'launched' | 'paused' | 'retired'; statusUpdatedAt: string; sourceBlock: number }
  >;
  getManifestError?: Error;
  getLifecycleError?: Error;
} = {}): MockRegistryGet {
  const manifests = args.manifests ?? new Map();
  const lifecycle = args.lifecycleStatuses ?? new Map();
  const getManifestCalls: string[] = [];
  return {
    async publishManifest() {
      throw new Error('not used');
    },
    async publishLifecycleTransition() {
      throw new Error('not used');
    },
    async listLaunched() {
      return [];
    },
    async getManifest(arg) {
      getManifestCalls.push(arg.manifestCid);
      if (args.getManifestError) throw args.getManifestError;
      const found = manifests.get(arg.manifestCid);
      if (!found) {
        throw new Error(`manifest not found: ${arg.manifestCid}`);
      }
      return found;
    },
    async getManifestFromCache(arg) {
      // Cache-only lookup. Mirrors the Map-backed cache shape from the
      // production client: returns the cached body when present, else
      // null — never throws.
      return manifests.get(arg.manifestCid) ?? null;
    },
    async getLifecycleStatus(arg) {
      if (args.getLifecycleError) throw args.getLifecycleError;
      const found = lifecycle.get(arg.manifestCid);
      if (!found) throw new Error(`no lifecycle for ${arg.manifestCid}`);
      return found;
    },
    get getManifestCalls() {
      return getManifestCalls;
    },
  };
}

describe('GET /v1/solvernets/launched (Task 15)', () => {
  it('returns an empty list when no records exist', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: LaunchedSolverNetRecord[] };
    expect(body.records).toEqual([]);
  });

  it('returns all owned records, regardless of status', async () => {
    const { app } = buildTestApp({ store });
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'a', status: 'launched' }));
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'b', status: 'paused' }));
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'c', status: 'retired' }));

    const res = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: LaunchedSolverNetRecord[] };
    expect(body.records).toHaveLength(3);
    expect(body.records.map((r) => r.solverNetId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('filters by ?status=paused', async () => {
    const { app } = buildTestApp({ store });
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'a', status: 'launched' }));
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'b', status: 'paused' }));
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'c', status: 'retired' }));

    const res = await app.request('/v1/solvernets/launched?status=paused', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: LaunchedSolverNetRecord[] };
    expect(body.records.map((r) => r.solverNetId)).toEqual(['b']);
  });

  it('filters by ?status=retired and surfaces retired records', async () => {
    const { app } = buildTestApp({ store });
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'a', status: 'launched' }));
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'c', status: 'retired' }));

    const res = await app.request('/v1/solvernets/launched?status=retired', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: LaunchedSolverNetRecord[] };
    expect(body.records.map((r) => r.solverNetId)).toEqual(['c']);
  });

  it('filters by ?status=launched', async () => {
    const { app } = buildTestApp({ store });
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'a', status: 'launched' }));
    await store.writeRecord(makeOwnedRecord({ solverNetId: 'b', status: 'paused' }));

    const res = await app.request('/v1/solvernets/launched?status=launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: LaunchedSolverNetRecord[] };
    expect(body.records.map((r) => r.solverNetId)).toEqual(['a']);
  });

  it('rejects unknown status filter values with 400', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/launched?status=not-real', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_query');
  });

  it('requires auth', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  // ── Summary enrichment (follow-up .35) ──────────────────────────────────
  //
  // The endpoint enriches each row with a `summary?: SolverNetManifestSummary`
  // when the registry client's manifest cache has the cid. Cache miss →
  // `summary` omitted (operators see the bare record). Cache hit → the
  // SPA renders manifest name / contract / prices.

  it('embeds `summary` per row when the registry cache has the manifest', async () => {
    const a = makeOwnedRecord({ solverNetId: 'a', status: 'launched' });
    const b = makeOwnedRecord({ solverNetId: 'b', status: 'paused' });
    const manifestA = makeManifest({
      solverNetId: 'a',
      manifestCid: a.manifestCid,
    });
    const manifestB = makeManifest({
      solverNetId: 'b',
      manifestCid: b.manifestCid,
    });
    manifestA.name = 'Net A';
    manifestB.name = 'Net B';
    const registry = makeMockRegistryGet({
      manifests: new Map([
        [a.manifestCid, manifestA],
        [b.manifestCid, manifestB],
      ]),
    });
    const { app } = buildTestApp({ store, registry });
    await store.writeRecord(a);
    await store.writeRecord(b);

    const res = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<LaunchedSolverNetRecord & { summary?: SolverNetManifestSummary }>;
    };
    expect(body.records).toHaveLength(2);
    const byId = new Map(body.records.map((r) => [r.solverNetId, r]));
    const rowA = byId.get('a')!;
    const rowB = byId.get('b')!;
    expect(rowA.summary).toBeDefined();
    expect(rowA.summary?.name).toBe('Net A');
    expect(rowA.summary?.contractId).toBe('prediction');
    expect(rowA.summary?.contractVersion).toBe('v1');
    expect(rowA.summary?.solutionPriceWei).toBe('1000000000000000');
    expect(rowA.summary?.verdictPriceWei).toBe('500000000000000');
    expect(rowA.summary?.openRoles).toEqual(['solver', 'evaluator']);
    // Status comes from the local record, not the cached manifest body —
    // the daemon owns the authoritative lifecycle view.
    expect(rowA.summary?.status).toBe('launched');
    expect(rowB.summary?.status).toBe('paused');
  });

  it('omits `summary` when the cache misses (other-launcher / pre-cache rows)', async () => {
    const a = makeOwnedRecord({ solverNetId: 'a', status: 'launched' });
    // Empty cache → getManifestFromCache returns null for every cid.
    const registry = makeMockRegistryGet({});
    const { app } = buildTestApp({ store, registry });
    await store.writeRecord(a);

    const res = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<LaunchedSolverNetRecord & { summary?: SolverNetManifestSummary }>;
    };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.summary).toBeUndefined();
    // Bare record fields are still present so the SPA can fall back.
    expect(body.records[0]?.solverNetId).toBe('a');
    expect(body.records[0]?.manifestCid).toBe(a.manifestCid);
  });

  it('omits `summary` when no registry client is configured', async () => {
    const a = makeOwnedRecord({ solverNetId: 'a', status: 'launched' });
    // No registry dep — endpoint should still return rows, just without
    // summary enrichment.
    const { app } = buildTestApp({ store });
    await store.writeRecord(a);

    const res = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<LaunchedSolverNetRecord & { summary?: SolverNetManifestSummary }>;
    };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.summary).toBeUndefined();
  });

  it('mixes cache-hit and cache-miss rows: each row independently enriched or not', async () => {
    const hit = makeOwnedRecord({ solverNetId: 'hit', status: 'launched' });
    const miss = makeOwnedRecord({ solverNetId: 'miss', status: 'launched' });
    const manifestHit = makeManifest({
      solverNetId: 'hit',
      manifestCid: hit.manifestCid,
    });
    manifestHit.name = 'Cached SolverNet';
    const registry = makeMockRegistryGet({
      manifests: new Map([[hit.manifestCid, manifestHit]]),
    });
    const { app } = buildTestApp({ store, registry });
    await store.writeRecord(hit);
    await store.writeRecord(miss);

    const res = await app.request('/v1/solvernets/launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<LaunchedSolverNetRecord & { summary?: SolverNetManifestSummary }>;
    };
    const byId = new Map(body.records.map((r) => [r.solverNetId, r]));
    expect(byId.get('hit')?.summary?.name).toBe('Cached SolverNet');
    expect(byId.get('miss')?.summary).toBeUndefined();
  });
});

describe('GET /v1/solvernets/registry (Task 15)', () => {
  it('returns 503 when catalog dep is not configured', async () => {
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/registry', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('registry_unavailable');
  });

  it('returns the cached summaries with default filter (launched + paused, no retired)', async () => {
    const refreshedAt = new Date('2026-05-06T01:00:00.000Z');
    const catalog = makeMockCatalog({
      snapshot: [
        makeSummary({ solverNetId: 'a', status: 'launched' }),
        makeSummary({ solverNetId: 'b', status: 'paused' }),
        makeSummary({ solverNetId: 'c', status: 'retired' }),
      ],
      lastRefreshedAt: refreshedAt,
    });
    const { app } = buildTestApp({ store, catalog });

    const res = await app.request('/v1/solvernets/registry', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summaries: SolverNetManifestSummary[];
      lastRefreshedAt: string | null;
      lastError: { message: string; at: string } | null;
    };
    expect(body.summaries.map((s) => s.solverNetId)).toEqual(['a', 'b']);
    expect(body.lastRefreshedAt).toBe(refreshedAt.toISOString());
    expect(body.lastError).toBeNull();
  });

  it('surfaces lastError when the cache observed a refresh failure', async () => {
    const errAt = new Date('2026-05-06T01:00:00.000Z');
    const catalog = makeMockCatalog({
      snapshot: [],
      lastError: { message: 'subgraph timed out', at: errAt },
    });
    const { app } = buildTestApp({ store, catalog });

    const res = await app.request('/v1/solvernets/registry', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summaries: SolverNetManifestSummary[];
      lastRefreshedAt: string | null;
      lastError: { message: string; at: string } | null;
    };
    expect(body.summaries).toEqual([]);
    expect(body.lastRefreshedAt).toBeNull();
    expect(body.lastError).toEqual({
      message: 'subgraph timed out',
      at: errAt.toISOString(),
    });
  });

  it('passes the rpc_rate_limited code through in the lastError payload', async () => {
    // jinn-mono #325: the typed throttle signal must survive the daemon→SPA
    // hop so the operator UI can render an actionable message.
    const errAt = new Date('2026-05-06T01:00:00.000Z');
    const catalog = makeMockCatalog({
      snapshot: [],
      lastError: {
        message: 'OnchainDiscoveryAPI: getLogs for MetadataSet failed',
        at: errAt,
        code: 'rpc_rate_limited',
      },
    });
    const { app } = buildTestApp({ store, catalog });

    const res = await app.request('/v1/solvernets/registry', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastError: { message: string; at: string; code?: string } | null;
    };
    expect(body.lastError?.code).toBe('rpc_rate_limited');
  });

  it('forces a refresh when ?refresh=1 is supplied', async () => {
    const catalog = makeMockCatalog({
      snapshot: [makeSummary({ solverNetId: 'a', status: 'launched' })],
    });
    const { app } = buildTestApp({ store, catalog });

    expect(catalog.refreshCalls).toBe(0);
    const res = await app.request('/v1/solvernets/registry?refresh=1', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(catalog.refreshCalls).toBe(1);
  });

  it('does not refresh when ?refresh is missing', async () => {
    const catalog = makeMockCatalog({
      snapshot: [makeSummary({ solverNetId: 'a', status: 'launched' })],
    });
    const { app } = buildTestApp({ store, catalog });

    await app.request('/v1/solvernets/registry', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(catalog.refreshCalls).toBe(0);
  });

  it('filters by ?status=retired (might be empty)', async () => {
    const catalog = makeMockCatalog({
      snapshot: [
        makeSummary({ solverNetId: 'a', status: 'launched' }),
        makeSummary({ solverNetId: 'b', status: 'retired' }),
      ],
    });
    const { app } = buildTestApp({ store, catalog });

    const res = await app.request('/v1/solvernets/registry?status=retired', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summaries: SolverNetManifestSummary[] };
    expect(body.summaries.map((s) => s.solverNetId)).toEqual(['b']);
  });

  it('filters by ?status=launched (default-equivalent for that single status)', async () => {
    const catalog = makeMockCatalog({
      snapshot: [
        makeSummary({ solverNetId: 'a', status: 'launched' }),
        makeSummary({ solverNetId: 'b', status: 'paused' }),
        makeSummary({ solverNetId: 'c', status: 'retired' }),
      ],
    });
    const { app } = buildTestApp({ store, catalog });

    const res = await app.request('/v1/solvernets/registry?status=launched', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summaries: SolverNetManifestSummary[] };
    expect(body.summaries.map((s) => s.solverNetId)).toEqual(['a']);
  });

  it('rejects unknown status filter values with 400', async () => {
    const catalog = makeMockCatalog({});
    const { app } = buildTestApp({ store, catalog });
    const res = await app.request('/v1/solvernets/registry?status=banana', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_query');
  });

  it('requires auth', async () => {
    const catalog = makeMockCatalog({});
    const { app } = buildTestApp({ store, catalog });
    const res = await app.request('/v1/solvernets/registry', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/solvernets/registry/:cid (Task 15)', () => {
  it('returns 503 when registry dep is not configured and no owned cache matches', async () => {
    // CID is valid-shape so it passes the malformed-cid 400 guard and falls
    // through to the no-registry / no-owned-cache 503 path. The malformed-cid
    // 400 path is covered by a separate test below.
    const { app } = buildTestApp({ store });
    const res = await app.request(
      '/v1/solvernets/registry/bafynoownedrecord1234567890',
      {
        method: 'GET',
        headers: authHeaders(),
      },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('registry_unavailable');
  });

  it('rejects trivially-malformed cid with 400 even when no registry is configured', async () => {
    // Regression guard (#114): the owned-cache short-circuit and the
    // no-registry 503 guard must not run before CID shape validation,
    // otherwise garbage cids return 503 instead of 400 in no-registry mode.
    const { app } = buildTestApp({ store });
    const res = await app.request('/v1/solvernets/registry/not-a-cid', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_cid');
  });

  it('returns an owned cached manifest without requiring the registry client', async () => {
    const cid = 'bafyownedmanifestcache1234567890';
    const manifest = makeManifest({
      solverNetId: 'owned-local',
      manifestCid: cid,
    });
    const manifestPath = await store.writeManifestCache(cid, manifest);
    await store.writeRecord({
      ...makeOwnedRecord({ solverNetId: 'owned-local', status: 'launched' }),
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      manifestPath,
    });

    const registry = makeMockRegistryGet({
      getManifestError: new Error('registry should not be touched'),
    });
    const { app } = buildTestApp({ store, registry });

    const res = await app.request(`/v1/solvernets/registry/${cid}`, {
      method: 'GET',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: SolverNetManifestV1;
      lifecycle: { status: string; sourceBlock: number };
    };
    expect(body.manifest.name).toBe('owned-local');
    expect(body.manifest.solutionPriceWei).toBe('1000000000000000');
    expect(body.lifecycle).toEqual({
      status: 'launched',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      sourceBlock: 100,
    });
    expect(registry.getManifestCalls).toEqual([]);
  });

  it('ignores an owned cached manifest whose canonical hash does not match the record', async () => {
    const cid = 'bafyownedhashmismatch1234567890';
    const manifest = makeManifest({
      solverNetId: 'owned-hash-mismatch',
      manifestCid: cid,
    });
    const manifestPath = await store.writeManifestCache(cid, manifest);
    await store.writeRecord({
      ...makeOwnedRecord({ solverNetId: 'owned-hash-mismatch', status: 'launched' }),
      manifestCid: cid,
      manifestHash: `0x${'11'.repeat(32)}`,
      manifestPath,
    });

    const { app } = buildTestApp({ store });

    const res = await app.request(`/v1/solvernets/registry/${cid}`, {
      method: 'GET',
      headers: authHeaders(),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('registry_unavailable');
  });

  it.each(['launching', 'failed'] as const)(
    'serves an owned cached %s manifest before the lifecycle is anchored (issue #114)',
    async (status) => {
      const cid = `bafyowned${status}prebroadcast1234567890`;
      const solverNetId = `owned-${status}-prebroadcast`;
      const manifest = makeManifest({ solverNetId, manifestCid: cid });
      const manifestPath = await store.writeManifestCache(cid, manifest);
      await store.writeRecord({
        ...makeOwnedRecord({ solverNetId, status }),
        manifestCid: cid,
        manifestHash: manifestHash(manifest),
        manifestPath,
        registry: {},
        launchProgress: {
          phase: 'broadcasting',
          attemptCount: status === 'failed' ? 3 : 0,
          ...(status === 'failed'
            ? { txError: { message: 'setMetadata failed', at: '2026-05-06T00:00:00.000Z' } }
            : {}),
        },
      });

      const { app } = buildTestApp({ store });

      const res = await app.request(`/v1/solvernets/registry/${cid}`, {
        method: 'GET',
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        manifest: SolverNetManifestV1;
        lifecycle: { status: string; statusUpdatedAt: string; sourceBlock: number };
      };
      expect(body.manifest.solverNetId).toBe(solverNetId);
      // No on-chain anchor yet — synthesise a `launched` lifecycle so the SPA
      // can render real manifest fields. The record-level `status` (carried
      // separately in the record query) still shows the `launching`/`failed` pill.
      expect(body.lifecycle.status).toBe('launched');
      expect(body.lifecycle.sourceBlock).toBe(0);
      expect(typeof body.lifecycle.statusUpdatedAt).toBe('string');
    },
  );

  it('happy path: returns the manifest + lifecycle status', async () => {
    const cid = 'bafyabcdef1234567890';
    const manifest = makeManifest({ solverNetId: 'happy', manifestCid: cid });
    const registry = makeMockRegistryGet({
      manifests: new Map([[cid, manifest]]),
      lifecycleStatuses: new Map([
        [
          cid,
          { status: 'launched', statusUpdatedAt: '2026-05-06T01:00:00.000Z', sourceBlock: 12 },
        ],
      ]),
    });
    const { app } = buildTestApp({ store, registry });

    const res = await app.request(`/v1/solvernets/registry/${cid}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: SolverNetManifestV1;
      lifecycle: {
        status: 'launched' | 'paused' | 'retired';
        statusUpdatedAt: string;
        sourceBlock: number;
      };
    };
    expect(body.manifest.solverNetId).toBe('happy');
    expect(body.lifecycle.status).toBe('launched');
    expect(body.lifecycle.statusUpdatedAt).toBe('2026-05-06T01:00:00.000Z');
    expect(body.lifecycle.sourceBlock).toBe(12);
    expect(registry.getManifestCalls).toEqual([cid]);
  });

  it('returns 404 when the registry getManifest throws (hash mismatch / missing)', async () => {
    const cid = 'bafytamperedmanifest';
    const registry = makeMockRegistryGet({
      getManifestError: new Error('manifest hash mismatch for cid'),
    });
    const { app } = buildTestApp({ store, registry });

    const res = await app.request(`/v1/solvernets/registry/${cid}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('manifest_not_found');
    expect(body.message).toMatch(/hash mismatch/);
  });

  it('returns 404 when the lifecycle lookup throws (no events on chain)', async () => {
    const cid = 'bafyhasmanifestnolifecycle';
    const manifest = makeManifest({ solverNetId: 'orphan', manifestCid: cid });
    const registry = makeMockRegistryGet({
      manifests: new Map([[cid, manifest]]),
      // Default lifecycle map is empty → getLifecycleStatus throws.
    });
    const { app } = buildTestApp({ store, registry });

    const res = await app.request(`/v1/solvernets/registry/${cid}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('manifest_not_found');
  });

  it('falls back to owned cached manifest when the registry client throws (issue #114)', async () => {
    const cid = 'bafyownedregistrythrows1234567890';
    const manifest = makeManifest({
      solverNetId: 'owned-registry-throws',
      manifestCid: cid,
    });
    const manifestPath = await store.writeManifestCache(cid, manifest);
    await store.writeRecord({
      ...makeOwnedRecord({ solverNetId: 'owned-registry-throws', status: 'launching' }),
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      manifestPath,
      registry: {},
    });

    // Registry IS wired but every call throws — simulates Anvil/local dev
    // where the Ponder indexer is unreachable but the operator owns the
    // record + has the manifest in the local cache.
    const registry = makeMockRegistryGet({
      getManifestError: new Error('subgraph unreachable'),
    });
    const { app } = buildTestApp({ store, registry });

    const res = await app.request(`/v1/solvernets/registry/${cid}`, {
      method: 'GET',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: SolverNetManifestV1;
      lifecycle: { status: string; sourceBlock: number };
    };
    expect(body.manifest.solverNetId).toBe('owned-registry-throws');
    expect(body.lifecycle.status).toBe('launched');
    expect(body.lifecycle.sourceBlock).toBe(0);
  });

  it('rejects trivially-malformed cid with 400', async () => {
    const registry = makeMockRegistryGet({});
    const { app } = buildTestApp({ store, registry });

    // CID must start with `Qm` (CIDv0) or `bafy` (CIDv1 base32).
    const res = await app.request('/v1/solvernets/registry/not-a-cid', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_cid');
  });

  it('accepts CIDv0 (Qm-prefixed) cids', async () => {
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const manifest = makeManifest({ solverNetId: 'cidv0', manifestCid: cid });
    const registry = makeMockRegistryGet({
      manifests: new Map([[cid, manifest]]),
      lifecycleStatuses: new Map([
        [cid, { status: 'paused', statusUpdatedAt: '2026-05-06T02:00:00.000Z', sourceBlock: 99 }],
      ]),
    });
    const { app } = buildTestApp({ store, registry });

    const res = await app.request(`/v1/solvernets/registry/${cid}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: SolverNetManifestV1;
      lifecycle: { status: string };
    };
    expect(body.manifest.solverNetId).toBe('cidv0');
    expect(body.lifecycle.status).toBe('paused');
  });

  it('requires auth', async () => {
    const registry = makeMockRegistryGet({});
    const { app } = buildTestApp({ store, registry });
    const res = await app.request('/v1/solvernets/registry/bafyanything', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(401);
  });
});
