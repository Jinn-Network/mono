import { describe, expect, it, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { addOperatorArtifactsRoutes } from '../../src/api/operator-artifacts-endpoint.js';

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

describe('GET /v1/operator/artifacts', () => {
  it('lists served artifacts with pricing and storage summary', async () => {
    const store = memoryStore();
    store.saveServedArtifact({
      sha256: 'a'.repeat(64),
      artifactType: 'design_document',
      requestId: 'req-1',
      envelopeCid: 'bafy-envelope',
      content: Buffer.from('artifact body'),
      priceUsdc: '0.002',
      createdAt: '2026-05-07T10:00:00.000Z',
    });
    store.saveNetworkArtifact({
      sha256: 'b'.repeat(64),
      artifactType: 'runtime_log',
      envelopeCid: 'bafy-network',
      content: Buffer.from('cached'),
      source: 'origin',
      sourceOperator: '0xoperator',
      sourceEndpoint: 'https://peer.example.com',
      paidAmountUsdc: '0.001',
      fetchedAt: '2026-05-07T11:00:00.000Z',
    });
    store.recordArtifactAccessEvent({
      sha256: 'a'.repeat(64),
      artifactType: 'design_document',
      priceUsdc: '0.002',
      outcome: 'paid_served',
      httpStatus: 200,
      payer: '0xpayer',
      settlementTx: '0xtx',
      createdAt: '2026-05-07T10:30:00.000Z',
    });

    const app = new Hono();
    const configPath = join(mkdtempSync(join(tmpdir(), 'jinn-operator-artifacts-')), 'config.json');
    addOperatorArtifactsRoutes(app, {
      store,
      configPath,
      operatorConfig: {
        publicEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        donation: { enabled: false },
      },
    });

    const res = await app.request('/v1/operator/artifacts?source=served');

    expect(res.status).toBe(200);
    const body = await res.json() as {
      artifacts: Array<{
        source: string;
        endpoint: string;
        priceUsdc: string;
        access: { accessCount: number; paidServeCount: number; revenueUsdc: string };
      }>;
      summary: {
        served: { totalCount: number; gatedCount: number; totalBytes: number };
        network: { totalCount: number };
        access: { accessCount: number; paidServeCount: number; revenueUsdc: string };
      };
      recentAccesses: Array<{ outcome: string; payer: string | null }>;
    };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({
      source: 'served',
      priceUsdc: '0.002',
      endpoint: `https://op.example.com/v1/artifacts/${'a'.repeat(64)}/content`,
    });
    expect(body.summary.served.totalCount).toBe(1);
    expect(body.summary.served.gatedCount).toBe(1);
    expect(body.summary.served.totalBytes).toBe(Buffer.from('artifact body').length);
    expect(body.summary.network.totalCount).toBe(1);
    expect(body.summary.access.accessCount).toBe(1);
    expect(body.summary.access.paidServeCount).toBe(1);
    expect(body.summary.access.revenueUsdc).toBe('0.002');
    expect(body.artifacts[0]?.access).toMatchObject({
      accessCount: 1,
      paidServeCount: 1,
      revenueUsdc: '0.002',
    });
    expect(body.recentAccesses[0]).toMatchObject({ outcome: 'paid_served', payer: '0xpayer' });

    const aliasRes = await app.request('/v1/operator/execution-data?source=served&limit=1');
    expect(aliasRes.status).toBe(200);
    const aliasBody = await aliasRes.json() as {
      artifacts: Array<{ source: string; priceUsdc: string }>;
    };
    expect(aliasBody.artifacts).toEqual([
      expect.objectContaining({ source: 'served', priceUsdc: '0.002' }),
    ]);
  });

  it('lists cached network artifacts when source=network', async () => {
    const store = memoryStore();
    store.saveNetworkArtifact({
      sha256: 'c'.repeat(64),
      artifactType: 'session_transcript',
      envelopeCid: 'bafy-cached',
      content: Buffer.from('cached transcript'),
      source: 'route-resolver',
      sourceOperator: '0xsafe',
      sourceEndpoint: 'https://peer.example.com',
      paidAmountUsdc: '0',
      fetchedAt: '2026-05-07T11:00:00.000Z',
    });

    const app = new Hono();
    addOperatorArtifactsRoutes(app, { store });

    const res = await app.request('/v1/operator/artifacts?source=network');

    expect(res.status).toBe(200);
    const body = await res.json() as {
      artifacts: Array<{ source: string; origin: string; paidAmountUsdc: string }>;
    };
    expect(body.artifacts).toEqual([
      expect.objectContaining({
        source: 'network',
        origin: 'route-resolver',
        paidAmountUsdc: '0',
      }),
    ]);
  });
});

describe('POST /v1/operator/pricing', () => {
  it('persists future-artifact pricing under config.operator', async () => {
    const store = memoryStore();
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-pricing-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify({ network: 'testnet' }, null, 2)}\n`);

    const app = new Hono();
    addOperatorArtifactsRoutes(app, { store, configPath });

    const res = await app.request('/v1/operator/pricing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0.001',
        perArtifactTypePrice: { design_document: '0.01' },
        donation: { enabled: true },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; restartRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      operator: unknown;
      network: string;
    };
    expect(persisted.network).toBe('testnet');
    expect(persisted.operator).toEqual({
      publicEndpoint: 'https://op.example.com',
      defaultPriceUsdc: '0.001',
      perArtifactTypePrice: { design_document: '0.01' },
      donation: { enabled: true },
    });
  });

  it('persists donation settings without requiring publicEndpoint', async () => {
    const store = memoryStore();
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-pricing-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, `${JSON.stringify({ network: 'testnet' }, null, 2)}\n`);

    const app = new Hono();
    addOperatorArtifactsRoutes(app, { store, configPath });

    const res = await app.request('/v1/operator/pricing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        donation: { enabled: true },
      }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      operator: unknown;
    };
    expect(persisted.operator).toEqual({
      publicEndpoint: '',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
      donation: { enabled: true },
    });
  });

  it('rejects malformed price strings', async () => {
    const store = memoryStore();
    const app = new Hono();
    addOperatorArtifactsRoutes(app, {
      store,
      operatorConfig: {
        publicEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        donation: { enabled: false },
      },
    });

    const res = await app.request('/v1/operator/pricing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicEndpoint: 'https://op.example.com',
        defaultPriceUsdc: 'free',
      }),
    });

    expect(res.status).toBe(400);
  });
});
