import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';
import { handleAcquireArtifact } from '../../src/mcp/acquire-artifact.js';

describe('acquire_artifact (daemon proxy + fast paths)', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => store.close());

  it('returns from served_artifacts without proxying to daemon', async () => {
    const bytes = Buffer.from('own content');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    store.saveServedArtifact({
      sha256,
      artifactType: 'design_document',
      content: bytes,
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called for self-store hit');
    });
    const result = await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.source).toBe('self-store');
      expect(result.content.bytes.toString()).toBe('own content');
      expect(result.content.artifactType).toBe('design_document');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns from network_artifacts cache without proxying to daemon', async () => {
    const sha256 = 'b'.repeat(64);
    const bytes = Buffer.from('cached content');
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'design_document',
      content: bytes,
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called for cache hit');
    });
    const result = await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.source).toBe('cache');
      expect(result.content.bytes.toString()).toBe('cached content');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('proxies to daemon when no fast path hits and forwards bearer header', async () => {
    const fetchedBytes = Buffer.from('fetched');
    const sha256 = createHash('sha256').update(fetchedBytes).digest('hex');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          sha256,
          content: fetchedBytes.toString('base64'),
          artifactType: 'design_document',
          source: 'origin',
          paidAmountUsdc: '0',
          fetchedAt: '2026-04-30T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const result = await handleAcquireArtifact(
      'http://127.0.0.1:7331',
      store,
      {
        sha256,
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      },
      'unit-token',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.source).toBe('origin');
      expect(result.content.bytes.equals(fetchedBytes)).toBe(true);
    }
    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe('http://127.0.0.1:7331/v1/artifacts/acquire');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer unit-token');
    fetchSpy.mockRestore();
  });

  it('omits Authorization header when no daemonApiToken is supplied', async () => {
    const sha256 = createHash('sha256').update(Buffer.from('x')).digest('hex');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          sha256,
          content: Buffer.from('x').toString('base64'),
          artifactType: 'design_document',
          source: 'origin',
          paidAmountUsdc: '0',
          fetchedAt: '2026-04-30T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('forwards envelopeCid + artifactType hints to the daemon route', async () => {
    const sha256 = createHash('sha256').update(Buffer.from('x')).digest('hex');
    const ownerSafe = '0x' + '2'.repeat(40);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          sha256,
          content: Buffer.from('x').toString('base64'),
          artifactType: 'design_document',
          source: 'origin',
          paidAmountUsdc: '0.01',
          fetchedAt: '2026-04-30T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0.01' },
      envelopeCid: 'bafyEnv',
      artifactType: 'design_document',
      ownerSafe,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0.01' },
      envelopeCid: 'bafyEnv',
      artifactType: 'design_document',
      ownerSafe,
    });
    fetchSpy.mockRestore();
  });

  it('forwards donated IPFS sources and mirrors an IPFS daemon result with ipfs provenance', async () => {
    const fetchedBytes = Buffer.from('donated-bytes');
    const sha256 = createHash('sha256').update(fetchedBytes).digest('hex');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          sha256,
          content: fetchedBytes.toString('base64'),
          artifactType: 'design_document',
          source: 'ipfs',
          paidAmountUsdc: '0',
          fetchedAt: '2026-04-30T00:00:00.000Z',
          sourceOperator: '0x' + '2'.repeat(40),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const sources = [{
      kind: 'ipfs' as const,
      cid: 'bafy-donated',
      sha256,
      encoding: 'jinn.artifact.donation.v1' as const,
    }];

    const result = await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      envelopeCid: 'bafyEnv',
      artifactType: 'design_document',
      sources,
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.sources).toEqual(sources);
    const row = store.getNetworkArtifact(sha256);
    expect(row?.sourceEndpoint).toBe('ipfs://bafy-donated');
    expect(row?.sourceOperator).toBe('0x' + '2'.repeat(40));
    fetchSpy.mockRestore();
  });

  it('surfaces structured error when daemon returns ok:false', async () => {
    const sha256 = 'd'.repeat(64);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          reason: 'hash_mismatch',
          sha256,
          error: 'hash mismatch: expected …',
          retryable: false,
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const result = await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('acquire_failed');
      expect(result.reason).toBe('hash_mismatch');
      expect(result.retryable).toBe(false);
    }
    fetchSpy.mockRestore();
  });

  it('returns daemon_unreachable when daemonApiUrl is undefined', async () => {
    const sha256 = 'g'.repeat(64);
    const result = await handleAcquireArtifact(undefined, store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('daemon_unreachable');
    }
  });

  it('touches network_artifacts last_used_at on cache hit', async () => {
    const sha256 = 'f'.repeat(64);
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'design_document',
      content: Buffer.from('cached'),
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    const row = store.getNetworkArtifact(sha256);
    expect(row).not.toBeNull();
    // last_used_at should be ISO timestamp now (post 2026-04-30)
    expect(row!.lastUsedAt >= '2026-04-30T00:00:00.000Z').toBe(true);
  });
  // ── verification (#4179) ────────────────────────────────────────────────────
  //
  // The daemon-proxy path used to trust the HTTP hop ("hash verification was
  // already done daemon-side") and mirror the decoded bytes straight into the
  // shared cache, where the unverified-cache-read fast path would then serve
  // them to every later caller. These cases close that.

  it('refuses daemon-proxied bytes that do not hash to the requested address', async () => {
    const sha256 = createHash('sha256').update(Buffer.from('the real bytes')).digest('hex');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          sha256,
          content: Buffer.from('substituted bytes').toString('base64'),
          artifactType: 'design_document',
          source: 'origin',
          paidAmountUsdc: '0',
          fetchedAt: '2026-04-30T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('acquire_failed');
      expect(result.reason).toBe('hash_mismatch');
      expect(result.sha256).toBe(sha256);
      expect(result.retryable).toBe(false);
    }
    // The unverified mirror is the actual defect: nothing may enter the cache.
    expect(store.getNetworkArtifact(sha256)).toBeNull();
    fetchSpy.mockRestore();
  });

  it('still mirrors and returns the full result shape on a verified proxy hit', async () => {
    const bytes = Buffer.from('verified bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sourceOperator = '0x' + '3'.repeat(40);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          sha256,
          content: bytes.toString('base64'),
          artifactType: 'design_document',
          source: 'origin',
          paidAmountUsdc: '0.01',
          fetchedAt: '2026-04-30T00:00:00.000Z',
          sourceOperator,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0.01' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toMatchObject({
        sha256,
        artifactType: 'design_document',
        source: 'origin',
        paidAmountUsdc: '0.01',
        fetchedAt: '2026-04-30T00:00:00.000Z',
        sourceOperator,
      });
      expect(result.content.bytes.equals(bytes)).toBe(true);
    }
    expect(store.getNetworkArtifact(sha256)?.content.equals(bytes)).toBe(true);
    fetchSpy.mockRestore();
  });

  it('refuses a corrupted served_artifacts row rather than serving it', async () => {
    const sha256 = createHash('sha256').update(Buffer.from('what was promised')).digest('hex');
    store.saveServedArtifact({
      sha256,
      artifactType: 'design_document',
      content: Buffer.from('not what was promised'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called after a self-store refusal');
    });

    const result = await handleAcquireArtifact('http://127.0.0.1:7331', store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hash_mismatch');
      expect(result.retryable).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
