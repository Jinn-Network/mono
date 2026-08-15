import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  handleInspectRecord,
  handleSearchRecords,
} from '../../src/mcp/search-records.js';
import { Store } from '../../src/store/store.js';
import type { EnvelopeProjection, EnvelopeRef, ManifestPreview } from '../../src/corpus/index.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';

const envelopeRef: EnvelopeRef = {
  manifestCid: 'bafyManifest',
  manifestHash: '0x' + 'c'.repeat(64),
  operator: { agentId: '2', safeAddress: '0x' + '2'.repeat(40) },
  evidenceTier: 'committed',
  publishedAt: 1745978400,
};

function makeEnvelope(overrides: Partial<SignedEnvelope> = {}): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'prediction.v1',
    role: 'solution',
    generatedAt: 1745978500,
    task: {
      cid: 'bafyTask',
      onchainCreationTx: '0x' + '1'.repeat(64),
      onchainCreationBlock: 123,
      requestId: '0x' + '3'.repeat(64),
    },
    participant: {
      safeAddress: '0x' + '4'.repeat(40),
      agentEoa: '0x' + '5'.repeat(40),
    },
    window: { startTs: 1745978400, endTs: 1745978500 },
    executor: {
      implName: 'unit',
      implVersion: '1.0.0',
      clientGitSha: 'abc123',
      codeDigest: `sha256:${'6'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'7'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: '0x' + '8'.repeat(64) },
    },
    evidenceTier: 'committed',
    attestation: null,
    trajectory: null,
    artifacts: [{
      artifactType: 'output.prediction.v1',
      sha256: 'b'.repeat(64),
      access: { endpoint: 'https://operator.example.com/artifacts/b', priceUsdc: '0.25' },
      metadata: { description: 'prediction output' },
    }],
    payload: { verdict: 'SCORED', solverBrier: 0.12 },
    signature: {
      algo: 'secp256k1',
      signer: '0x' + '5'.repeat(40),
      hash: '0x' + '9'.repeat(64),
      sig: '0x' + 'a'.repeat(130),
    },
    ...overrides,
  };
}

function makePreview(ref: EnvelopeRef = envelopeRef, envelope = makeEnvelope()): ManifestPreview {
  return { ref, envelope };
}

function makeReadOnlyCorpus(preview: ManifestPreview | ManifestPreview[] = makePreview()) {
  const previews = Array.isArray(preview) ? preview : [preview];
  return {
    query: vi.fn(async () => previews.map((item) => item.ref)),
    fetchManifest: vi.fn(async (ref: EnvelopeRef) =>
      previews.find((item) => item.ref.manifestCid === ref.manifestCid) ?? previews[0]!
    ),
    read: vi.fn(async () => { throw new Error('read must not be called'); }),
    acquire: vi.fn(async () => { throw new Error('acquire must not be called'); }),
    acquireBySha256: vi.fn(async () => { throw new Error('acquireBySha256 must not be called'); }),
  };
}

function makeProjection(overrides: Partial<EnvelopeProjection> = {}): EnvelopeProjection {
  return {
    envelopeId: 'projection-1',
    envelopeCid: 'bafyManifest',
    envelopeSha256: '0x' + 'd'.repeat(64),
    signatureHash: '0x' + 'e'.repeat(64),
    solverType: 'prediction.v1',
    role: 'verdict',
    taskCid: 'bafyTask',
    taskId: 'task-1',
    requestId: '0x' + '3'.repeat(64),
    generatedAt: 1745978600,
    evidenceTier: 'committed',
    participantSafeAddress: '0x' + '4'.repeat(40),
    participantAgentEoa: '0x' + '5'.repeat(40),
    executorImplName: 'unit',
    executorImplVersion: '1.0.0',
    executorRuntimeBundleDigest: `sha256:${'7'.repeat(64)}`,
    executorPlugins: [],
    solutionEnvelopeCid: null,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: null,
    metadata: { verdict: 'SCORED', 'scores.solverBrier': 0.12 },
    ...overrides,
  };
}

describe('search_records (corpus-backed)', () => {
  it('returns local envelope projection descriptors before network records', async () => {
    const store = new Store(':memory:');
    store.saveEnvelopeProjection(makeProjection());
    const corpus = makeReadOnlyCorpus();

    const out = await handleSearchRecords(corpus, store, {
      solverType: 'prediction.v1',
      taskCid: 'bafyTask',
      limit: 10,
    });

    expect(out.records.map((record) => record.recordRef)).toEqual([
      'projection:projection-1',
      'network:envelope:bafyManifest',
    ]);
    expect(out.records[0]).toMatchObject({
      source: 'local',
      taskRef: {
        cid: 'bafyTask',
        id: 'task-1',
        requestId: '0x' + '3'.repeat(64),
      },
      solverType: 'prediction.v1',
      role: 'verdict',
      scoreMetadata: { verdict: 'SCORED', 'scores.solverBrier': 0.12 },
    });
    expect(corpus.read).not.toHaveBeenCalled();
    expect(corpus.acquire).not.toHaveBeenCalled();
    expect(corpus.acquireBySha256).not.toHaveBeenCalled();
    store.close();
  });

  it('returns local record descriptors with access and price metadata', async () => {
    const store = new Store(':memory:');
    store.saveServedArtifact({
      sha256: 'a'.repeat(64),
      artifactType: 'output.prediction.v1',
      requestId: '0x' + '1'.repeat(64),
      envelopeCid: 'bafyLocalEnvelope',
      content: Buffer.from('local'),
      priceUsdc: '0.05',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = makeReadOnlyCorpus(makePreview(envelopeRef, makeEnvelope({
      artifacts: [{
        artifactType: 'output.other',
        sha256: 'f'.repeat(64),
        access: { endpoint: 'https://operator.example.com/artifacts/f', priceUsdc: '1' },
      }],
    })));

    const out = await handleSearchRecords(corpus, store, { artifactType: 'output.prediction.v1', limit: 10 });

    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.recordRef).toBe(`local:served:${'a'.repeat(64)}`);
    expect(out.records[0]?.artifactRefs[0]).toMatchObject({
      sha256: 'a'.repeat(64),
      source: 'local',
      localSource: 'served',
      access: { endpoint: null, priceUsdc: '0.05' },
      contentSize: 5,
    });
    expect(corpus.query).toHaveBeenCalledOnce();
    expect(corpus.fetchManifest).toHaveBeenCalledOnce();
    store.close();
  });

  it('returns network record descriptors with acquire_artifact arguments', async () => {
    const store = new Store(':memory:');
    const corpus = makeReadOnlyCorpus();

    const out = await handleSearchRecords(corpus, store, { solverType: 'prediction.v1', limit: 10 });

    expect(out.records).toHaveLength(1);
    const record = out.records[0]!;
    expect(record.recordRef).toBe('network:envelope:bafyManifest');
    expect(record.taskRef?.cid).toBe('bafyTask');
    expect(record.artifactRefs[0]?.acquisition).toEqual({
      tool: 'acquire_artifact',
      arguments: {
        sha256: 'b'.repeat(64),
        access: { endpoint: 'https://operator.example.com/artifacts/b', priceUsdc: '0.25' },
        envelopeCid: 'bafyManifest',
        artifactType: 'output.prediction.v1',
        ownerSafe: '0x' + '4'.repeat(40),
      },
    });
    store.close();
  });

  it('includes donated IPFS sources in acquire_artifact arguments', async () => {
    const store = new Store(':memory:');
    const donatedSha = '1'.repeat(64);
    const corpus = makeReadOnlyCorpus(makePreview(envelopeRef, makeEnvelope({
      artifacts: [{
        artifactType: 'output.prediction.v1',
        sha256: donatedSha,
        access: { endpoint: 'https://operator.example.com/artifacts/donated', priceUsdc: '0' },
        sources: [{
          kind: 'ipfs',
          cid: 'bafy-donated',
          sha256: donatedSha,
          encoding: 'jinn.artifact.donation.v1',
        }],
      }],
    })));

    const out = await handleSearchRecords(corpus, store, { solverType: 'prediction.v1', limit: 10 });

    expect(out.records[0]?.artifactRefs[0]?.acquisition?.arguments.sources).toEqual([{
      kind: 'ipfs',
      cid: 'bafy-donated',
      sha256: donatedSha,
      encoding: 'jinn.artifact.donation.v1',
    }]);
    store.close();
  });

  it('returns SWE donated execution data with IPFS acquisition arguments', async () => {
    const store = new Store(':memory:');
    const donatedSha = '2'.repeat(64);
    const corpus = makeReadOnlyCorpus(makePreview(envelopeRef, makeEnvelope({
      solverType: 'swe-rebench-v2.v1',
      role: 'solution',
      artifacts: [{
        artifactType: 'swe-rebench-v2_v1_solution',
        sha256: donatedSha,
        access: { endpoint: 'http://localhost:7332/v1/artifacts/content', priceUsdc: '0' },
        sources: [{
          kind: 'ipfs',
          cid: 'bafy-swe-donated',
          sha256: donatedSha,
          encoding: 'jinn.artifact.donation.v1',
        }],
      }],
    })));

    const out = await handleSearchRecords(corpus, store, {
      solverType: 'swe-rebench-v2.v1',
      role: 'solution',
      artifactType: 'swe-rebench-v2_v1_solution',
      limit: 10,
    });

    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.solverType).toBe('swe-rebench-v2.v1');
    expect(out.records[0]?.artifactRefs[0]?.acquisition).toEqual({
      tool: 'acquire_artifact',
      arguments: {
        sha256: donatedSha,
        access: { endpoint: 'http://localhost:7332/v1/artifacts/content', priceUsdc: '0' },
        envelopeCid: envelopeRef.manifestCid,
        artifactType: 'swe-rebench-v2_v1_solution',
        ownerSafe: '0x' + '4'.repeat(40),
        sources: [{
          kind: 'ipfs',
          cid: 'bafy-swe-donated',
          sha256: donatedSha,
          encoding: 'jinn.artifact.donation.v1',
        }],
      },
    });
    store.close();
  });

  it('post-filters network records after fetching manifests', async () => {
    const store = new Store(':memory:');
    const matchingRef = { ...envelopeRef, manifestCid: 'bafyVerdict' };
    const solutionRef = { ...envelopeRef, manifestCid: 'bafySolution' };
    const corpus = makeReadOnlyCorpus([
      makePreview(solutionRef, makeEnvelope({
        role: 'solution',
        task: {
          cid: 'bafyOtherTask',
          onchainCreationTx: '0x' + '1'.repeat(64),
          onchainCreationBlock: 123,
          requestId: '0x' + '4'.repeat(64),
        },
      })),
      makePreview(matchingRef, makeEnvelope({
        role: 'verdict',
        task: {
          cid: 'bafyTask',
          onchainCreationTx: '0x' + '1'.repeat(64),
          onchainCreationBlock: 123,
          requestId: '0x' + '3'.repeat(64),
        },
        payload: { verdict: 'SCORED', scores: { solverBrier: 0.12 } },
      })),
    ]);

    const out = await handleSearchRecords(corpus, store, {
      role: 'verdict',
      requestId: '0x' + '3'.repeat(64),
      participant: { agentEoa: '0x' + '5'.repeat(40) },
      metadata: { verdict: 'SCORED', 'scores.solverBrier': 0.12 },
      limit: 10,
    });

    expect(out.records.map((record) => record.recordRef)).toEqual(['network:envelope:bafyVerdict']);
    expect(corpus.fetchManifest).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('does not return network records for local-only taskId filters', async () => {
    const store = new Store(':memory:');
    const corpus = makeReadOnlyCorpus();

    const out = await handleSearchRecords(corpus, store, { taskId: 'task-1', limit: 10 });

    expect(out.records).toEqual([]);
    expect(corpus.fetchManifest).toHaveBeenCalledOnce();
    store.close();
  });

  it('does not call acquisition/payment corpus methods', async () => {
    const store = new Store(':memory:');
    const corpus = makeReadOnlyCorpus();

    await handleSearchRecords(corpus, store, { limit: 10 });

    expect(corpus.read).not.toHaveBeenCalled();
    expect(corpus.acquire).not.toHaveBeenCalled();
    expect(corpus.acquireBySha256).not.toHaveBeenCalled();
    store.close();
  });
});

describe('search_records (corpus=null fallback)', () => {
  it('returns local envelope projection descriptors with role filtering', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new Store(':memory:');
      store.saveEnvelopeProjection(makeProjection({ envelopeId: 'projection-verdict', role: 'verdict' }));
      store.saveEnvelopeProjection(makeProjection({ envelopeId: 'projection-solution', role: 'solution' }));

      const out = await handleSearchRecords(null, store, { role: 'verdict', limit: 10 });

      expect(out.records.map((record) => record.recordRef)).toEqual(['projection:projection-verdict']);
      expect(out.warning).toMatch(/corpus not configured/);
      store.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns local results, warning, and console.warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new Store(':memory:');
      store.saveServedArtifact({
        sha256: 'a'.repeat(64),
        artifactType: 'output.prediction.v1',
        content: Buffer.from('local-only'),
        priceUsdc: '0',
        createdAt: '2026-04-30T00:00:00.000Z',
      });

      const out = await handleSearchRecords(null, store, {
        artifactType: 'output.prediction.v1',
        limit: 10,
      });

      expect(out.records).toHaveLength(1);
      expect(out.warning).toMatch(/corpus not configured/);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/\[mcp:search_records\]/);
      store.close();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('inspect_record', () => {
  it('inspects a network envelope ref without acquiring bytes', async () => {
    const store = new Store(':memory:');
    store.saveEnvelopeProjection(makeProjection());
    const corpus = makeReadOnlyCorpus();

    const out = await handleInspectRecord(corpus, store, { ref: 'network:envelope:bafyManifest' });

    expect(out.record?.recordRef).toBe('network:envelope:bafyManifest');
    expect(out.projections).toHaveLength(1);
    expect(out.artifacts[0]?.acquisition?.arguments.access.priceUsdc).toBe('0.25');
    expect(corpus.fetchManifest).toHaveBeenCalledOnce();
    expect(corpus.read).not.toHaveBeenCalled();
    expect(corpus.acquire).not.toHaveBeenCalled();
    expect(corpus.acquireBySha256).not.toHaveBeenCalled();
    store.close();
  });

  it('inspects a cached local artifact by sha without fetch or acquisition', async () => {
    const store = new Store(':memory:');
    const sha256 = 'd'.repeat(64);
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'output.prediction.v1',
      content: Buffer.from('cached'),
      source: 'origin',
      sourceEndpoint: 'https://operator.example.com/artifacts/d',
      sourceOperator: '0x' + '6'.repeat(40),
      paidAmountUsdc: '0.15',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = makeReadOnlyCorpus();

    const out = await handleInspectRecord(corpus, store, { sha256 });

    expect(out.record?.recordRef).toBe(`local:network:${sha256}`);
    expect(out.artifacts[0]).toMatchObject({
      sha256,
      source: 'local',
      localSource: 'network',
      access: { endpoint: 'https://operator.example.com/artifacts/d', priceUsdc: '0.15' },
    });
    expect(corpus.fetchManifest).not.toHaveBeenCalled();
    expect(corpus.read).not.toHaveBeenCalled();
    expect(corpus.acquire).not.toHaveBeenCalled();
    expect(corpus.acquireBySha256).not.toHaveBeenCalled();
    store.close();
  });
});

describe('MCP record tool registration source', () => {
  it('removes search_artifacts and registers record-oriented tools', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../src/mcp/server.ts'), 'utf8');

    expect(source).not.toMatch(/server\.tool\(\s*['"]search_artifacts['"]/);
    expect(source).toMatch(/server\.tool\(\s*['"]search_records['"]/);
    expect(source).toMatch(/server\.tool\(\s*['"]inspect_record['"]/);
    expect(source).toMatch(/server\.tool\(\s*['"]acquire_artifact['"]/);
    expect(source).toMatch(/server\.tool\(\s*['"]get_task['"]/);
  });

  it('exposes corpus and projection filters on search_records', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../src/mcp/server.ts'), 'utf8');

    for (const field of [
      'solverType',
      'artifactType',
      'taskCid',
      'role',
      'taskId',
      'requestId',
      'participant',
      'safeAddress',
      'agentEoa',
      'metadata',
      'evidenceTier',
      'generatedAfter',
      'generatedBefore',
      'ownerSafe',
      'limit',
    ]) {
      expect(source).toContain(field);
    }
    expect(source).toContain('metadataValueSchema');
    expect(source).toContain('z.union([z.string(), z.number(), z.boolean()])');
  });
});
