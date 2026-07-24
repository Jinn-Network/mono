import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  CorpusDiscoveryPort,
  EnvelopeRef,
} from '@jinn-network/core/corpus-read';
import type { SignedEnvelope } from '@jinn-network/core';
import {
  createHarnessLayer,
  DEFAULT_TESTNET_DISCOVERY_URL,
} from '../src/consume.js';
import { SqliteCorpusStore } from '../src/corpus-store.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function fakeEnvelope(opts: {
  solverType: string;
  sha256: string;
  endpoint: string;
  participantSafe: string;
}): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: opts.solverType,
    role: 'solution',
    generatedAt: 1745978400,
    task: {
      cid: 'bafyTask',
      onchainCreationTx: '0x' + 'a'.repeat(64),
      onchainCreationBlock: 1,
      requestId: '0x' + 'b'.repeat(64),
    },
    participant: { safeAddress: opts.participantSafe, agentEoa: '0x' + '2'.repeat(40) },
    window: { startTs: 0, endTs: 1000 },
    executor: {
      implName: 'test',
      implVersion: '0.1.0',
      clientGitSha: 'abc',
      codeDigest: 'sha256:' + 'c'.repeat(64),
      runtimeBundleDigest: 'sha256:' + 'd'.repeat(64),
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [{
      artifactType: `output.${opts.solverType}`,
      sha256: opts.sha256,
      access: { endpoint: opts.endpoint, priceUsdc: '0' },
    }],
    payload: {},
    signature: {
      algo: 'secp256k1',
      signer: '0x' + '2'.repeat(40),
      hash: '0x' + 'e'.repeat(64),
      sig: '0x' + 'f'.repeat(130),
    },
  };
}

function fakeEnvelopeRef(manifestCid: string): EnvelopeRef {
  return {
    manifestCid,
    manifestHash: '0x' + 'a'.repeat(64),
    operator: { agentId: '7', safeAddress: '' },
    evidenceTier: 'self-signed',
    publishedAt: 1745978400,
  };
}

function stubDiscovery(envelopeRefs: EnvelopeRef[]): CorpusDiscoveryPort {
  return {
    queryEnvelopes: vi.fn().mockResolvedValue(envelopeRefs),
  };
}

describe('createHarnessLayer', () => {
  let store: SqliteCorpusStore;
  beforeEach(() => { store = new SqliteCorpusStore(':memory:'); });
  afterEach(() => store.close());

  it('resolves testnet defaults when endpoints are not overridden', () => {
    const layer = createHarnessLayer({ store, discovery: stubDiscovery([]) });
    expect(layer.config.discoveryUrl).toBe(DEFAULT_TESTNET_DISCOVERY_URL);
    expect(layer.config.ipfsGatewayUrl).toBe('https://gateway.autonolas.tech');
  });

  it('keeps operator overrides over testnet defaults', () => {
    const layer = createHarnessLayer({
      store,
      discovery: stubDiscovery([]),
      discoveryUrl: 'https://indexer.example.com',
      ipfsGatewayUrl: 'https://gateway.example.com',
    });
    expect(layer.config.discoveryUrl).toBe('https://indexer.example.com');
    expect(layer.config.ipfsGatewayUrl).toBe('https://gateway.example.com');
  });

  it('search() returns typed results against a mocked DiscoveryAPI', async () => {
    const opSafe = '0x' + 'a'.repeat(40);
    const bytes = Buffer.from('search bytes', 'utf-8');
    const discovery = stubDiscovery([fakeEnvelopeRef('bafyPred'), fakeEnvelopeRef('bafySwe')]);
    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
      if (cid === 'bafyPred') {
        return fakeEnvelope({ solverType: 'prediction.v1', sha256: sha256(bytes), endpoint: 'https://op.example.com', participantSafe: opSafe });
      }
      if (cid === 'bafySwe') {
        return fakeEnvelope({ solverType: 'swe-rebench-v2', sha256: sha256(bytes), endpoint: 'https://op.example.com', participantSafe: opSafe });
      }
      throw new Error('unknown CID');
    });

    const layer = createHarnessLayer({
      store,
      discovery,
      fetchFromIpfs,
      captureMetaUrl: '',
    });
    const hits = await layer.corpus.search('prediction');

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.ref).toBe('bafyPred');
    expect(hit.title).toContain('prediction.v1');
    expect(hit.solverType).toBe('prediction.v1');
    expect(hit.role).toBe('solution');
    // Provenance fields.
    expect(hit.operator.agentId).toBe('7');
    expect(hit.operator.safeAddress).toBe(opSafe); // enriched from the manifest participant
    expect(hit.evidenceTier).toBe('self-signed');
    expect(hit.publishedAt).toBe(1745978400);
    expect(hit.generatedAt).toBe(1745978400);
    expect(hit.task?.cid).toBe('bafyTask');
    expect(hit.artifactTypes).toEqual(['output.prediction.v1']);
  });

  it('search() with an empty query returns every fetched record', async () => {
    const opSafe = '0x' + 'a'.repeat(40);
    const bytes = Buffer.from('all bytes', 'utf-8');
    const discovery = stubDiscovery([fakeEnvelopeRef('bafyPred'), fakeEnvelopeRef('bafySwe')]);
    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) =>
      fakeEnvelope({
        solverType: cid === 'bafyPred' ? 'prediction.v1' : 'swe-rebench-v2',
        sha256: sha256(bytes),
        endpoint: 'https://op.example.com',
        participantSafe: opSafe,
      }));

    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs });
    const hits = await layer.corpus.search('');
    expect(hits.map((h) => h.ref).sort()).toEqual(['bafyPred', 'bafySwe']);
  });

  it('get() round-trips an artifact ref from a search result', async () => {
    const opSafe = '0x' + 'a'.repeat(40);
    const realBytes = Buffer.from('round-trip artifact bytes', 'utf-8');
    const realSha = sha256(realBytes);
    const discovery = stubDiscovery([fakeEnvelopeRef('bafyPred')]);
    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
      if (cid === 'bafyPred') {
        return fakeEnvelope({ solverType: 'prediction.v1', sha256: realSha, endpoint: 'https://op.example.com', participantSafe: opSafe });
      }
      throw new Error('unknown CID');
    });
    const acquireFn = vi.fn(async (_endpoint: string, sha: string) => (sha === realSha ? realBytes : null));

    const layer = createHarnessLayer({
      store,
      discovery,
      fetchFromIpfs,
      acquireFn,
      captureMetaUrl: '',
    });
    const hits = await layer.corpus.search('prediction');
    expect(hits).toHaveLength(1);

    const record = await layer.corpus.get(hits[0]!.ref);
    expect(record.ref).toBe('bafyPred');
    expect(record.envelope.solverType).toBe('prediction.v1');
    expect(record.artifacts).toHaveLength(1);
    expect(record.artifacts[0]!.sha256).toBe(realSha);
    expect(record.artifacts[0]!.content.equals(realBytes)).toBe(true);
    expect(record.artifacts[0]!.sizeBytes).toBe(realBytes.length);
  });
});

describe('content-aware search via capture meta (#1344)', () => {
  let store: SqliteCorpusStore;
  beforeEach(() => { store = new SqliteCorpusStore(':memory:'); });
  afterEach(() => store.close());

  function metaFetch(hits: unknown[]): typeof fetch {
    return vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/capture-meta')) {
        return new Response(JSON.stringify(hits), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('search("tdd") finds a seed tagged tdd via meta, with zero artifact fetches', async () => {
    const seedCid = 'bafySeedTdd';
    const envelope = fakeEnvelope({
      solverType: 'capture',
      sha256: 'a'.repeat(64),
      endpoint: 'http://127.0.0.1:7331',
      participantSafe: '0x' + '1'.repeat(40),
    });
    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
      if (cid === seedCid) return envelope;
      throw new Error(`unexpected ipfs fetch: ${cid}`);
    });
    const acquireFn = vi.fn(async () => { throw new Error('artifact fetch must not happen'); });
    // Discovery returns nothing — the old manifest-scan path cannot find this.
    const layer = createHarnessLayer({
      store,
      discovery: stubDiscovery([]),
      fetchFromIpfs,
      acquireFn,
      fetchImpl: metaFetch([{
        manifestCid: seedCid,
        taskSummary: 'Seed import: obra/superpowers/skills/test-driven-development',
        tags: ['seed-import', 'superpowers', 'test-driven-development', 'tdd'],
        repositorySlug: 'obra/superpowers',
        synthesis: 'Use a red-green-refactor loop.',
        retrievalVisible: true,
        provenance: 'imported',
        verifiabilityTier: 'user-accepted',
      }]),
    });
    const hits = await layer.corpus.search('tdd');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ref).toBe(seedCid);
    expect(hits[0]!.tags).toContain('tdd');
    expect(hits[0]!.summary).toContain('test-driven-development');
    expect(hits[0]!.repositorySlug).toBe('obra/superpowers');
    expect(hits[0]!.synthesis).toBe('Use a red-green-refactor loop.');
    expect(hits[0]!.retrievalVisible).toBe(true);
    expect(acquireFn).not.toHaveBeenCalled();
  });

  it('degrades to the manifest scan when the meta endpoint is unavailable', async () => {
    const cid = 'bafyManifestOnly';
    const envelope = fakeEnvelope({
      solverType: 'prediction.v0',
      sha256: 'b'.repeat(64),
      endpoint: 'http://127.0.0.1:7331',
      participantSafe: '0x' + '1'.repeat(40),
    });
    const fetchFromIpfs = vi.fn(async () => envelope);
    const failingFetch = vi.fn(async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
    const layer = createHarnessLayer({
      store,
      discovery: stubDiscovery([fakeEnvelopeRef(cid)]),
      fetchFromIpfs,
      fetchImpl: failingFetch,
    });
    const hits = await layer.corpus.search('prediction');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ref).toBe(cid);
  });

  it('meta hits and manifest hits dedupe by ref', async () => {
    const cid = 'bafyBoth';
    const envelope = fakeEnvelope({
      solverType: 'capture',
      sha256: 'c'.repeat(64),
      endpoint: 'http://127.0.0.1:7331',
      participantSafe: '0x' + '1'.repeat(40),
    });
    const fetchFromIpfs = vi.fn(async () => envelope);
    const layer = createHarnessLayer({
      store,
      discovery: stubDiscovery([fakeEnvelopeRef(cid)]),
      fetchFromIpfs,
      fetchImpl: metaFetch([{
        manifestCid: cid,
        taskSummary: 'a capture task',
        tags: ['capture'],
        provenance: 'contributed',
        verifiabilityTier: 'user-accepted',
      }]),
    });
    const hits = await layer.corpus.search('capture');
    expect(hits.filter((h) => h.ref === cid)).toHaveLength(1);
  });
});
