import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { Store } from '../../src/store/store.js';
import { addX402Routes } from '../../src/x402/handler.js';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('x402 handler — dynamic per-row price', () => {
  let store: Store;
  let app: Hono;

  beforeEach(() => {
    store = new Store(':memory:');
    app = new Hono();
    addX402Routes(app, store, {
      privateKey: TEST_PRIVATE_KEY,
      recipientAddress: '0x' + '1'.repeat(40),
      network: 'eip155:84532',
    });
  });

  afterEach(() => store.close());

  it('serves free content (priceUsdc=0) without payment dance', async () => {
    const sha256 = 'a'.repeat(64);
    const bytes = Buffer.from('free content', 'utf-8');
    store.saveServedArtifact({
      sha256,
      artifactType: 'design_document',
      content: bytes,
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await app.request(`/v1/artifacts/${sha256}/content`);
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(Buffer.from(body).equals(bytes)).toBe(true);
  });

  it('returns 402 for paid content without X-PAYMENT header', async () => {
    const sha256 = 'b'.repeat(64);
    store.saveServedArtifact({
      sha256,
      artifactType: 'output.prediction.v0',
      content: Buffer.from('paid'),
      priceUsdc: '0.001',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await app.request(`/v1/artifacts/${sha256}/content`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ price: string }> };
    expect(body.accepts).toBeDefined();
    expect(body.accepts.length).toBeGreaterThan(0);
    // The 402 response carries this artifact's price, not a server-static one.
    expect(body.accepts.some((a) => a.price.includes('0.001'))).toBe(true);
  });

  it('returns 404 for unknown sha256', async () => {
    const res = await app.request(`/v1/artifacts/${'c'.repeat(64)}/content`);
    expect(res.status).toBe(404);
  });

  // ─── Content-Type + X-Artifact-Type headers ────────────────────────────────

  it('sets Content-Type: application/octet-stream and X-Artifact-Type for unknown type (free path)', async () => {
    const sha256 = 'd'.repeat(64);
    store.saveServedArtifact({
      sha256,
      artifactType: 'output.prediction.v0',
      content: Buffer.from('data'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await app.request(`/v1/artifacts/${sha256}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/octet-stream/);
    expect(res.headers.get('X-Artifact-Type')).toBe('output.prediction.v0');
  });

  it('sets Content-Type: text/markdown for markdown artifact type (free path)', async () => {
    const sha256 = 'e'.repeat(64);
    store.saveServedArtifact({
      sha256,
      artifactType: 'design_document.markdown',
      content: Buffer.from('# Hello'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await app.request(`/v1/artifacts/${sha256}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/markdown/);
    expect(res.headers.get('X-Artifact-Type')).toBe('design_document.markdown');
  });

  it('sets Content-Type: application/gzip for tarball artifact type (free path)', async () => {
    const sha256 = 'f'.repeat(64);
    store.saveServedArtifact({
      sha256,
      artifactType: 'output.bundle.tar.gz',
      content: Buffer.from('fake-tar'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await app.request(`/v1/artifacts/${sha256}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/gzip/);
    expect(res.headers.get('X-Artifact-Type')).toBe('output.bundle.tar.gz');
  });
});
