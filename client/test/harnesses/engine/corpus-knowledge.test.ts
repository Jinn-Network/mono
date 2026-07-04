/**
 * #1393 — corpus knowledge autoload: loader unit tests.
 *
 * Store-only seams: envelope projections (via store.saveEnvelopeProjection)
 * carry solverType/role/evidenceTier; served_artifacts rows (via
 * store.saveServedArtifact) carry the artifact sha256s keyed by envelopeCid.
 * handleSearchRecords merges both; the loader ranks, dedupes, and trims.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../../src/store/store.js';
import { loadCorpusKnowledge } from '../../../src/harnesses/engine/corpus-knowledge.js';
import type { ReadOnlyCorpus } from '../../../src/mcp/search-records.js';
import type { EnvelopeProjection } from '../../../src/corpus/types.js';

function projection(overrides: Partial<EnvelopeProjection>): EnvelopeProjection {
  return {
    envelopeId: overrides.envelopeCid ?? 'env-default',
    envelopeCid: 'env-default',
    envelopeSha256: null,
    signatureHash: `0xsig-${overrides.envelopeCid ?? 'default'}`,
    solverType: 'prediction.v1',
    role: 'solution',
    taskCid: 'bafytask',
    taskId: null,
    requestId: null,
    generatedAt: 1_000,
    evidenceTier: 'self-signed',
    participantSafeAddress: '0xsafe',
    participantAgentEoa: '0xeoa',
    executorImplName: 'prediction-v1-baseline',
    executorImplVersion: '1.0.0',
    executorRuntimeBundleDigest: null,
    executorPlugins: [],
    solutionEnvelopeCid: null,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: null,
    metadata: {},
    ...overrides,
  };
}

describe('loadCorpusKnowledge (#1393)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('returns null when the store has no matching records (corpus-null)', async () => {
    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload).toBeNull();
  });

  it('ranks by evidence tier (attested > committed > self-signed) then generatedAt desc, slices 3', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-a', envelopeCid: 'env-a', evidenceTier: 'self-signed', generatedAt: 5_000 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-b', envelopeCid: 'env-b', evidenceTier: 'committed', generatedAt: 1_000 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-c', envelopeCid: 'env-c', evidenceTier: 'attested', generatedAt: 500 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-d', envelopeCid: 'env-d', evidenceTier: 'self-signed', generatedAt: 4_000 }));

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload).not.toBeNull();
    expect(payload!.records).toHaveLength(3);
    expect(payload!.records.map((r) => r.envelopeCid)).toEqual(['env-c', 'env-b', 'env-a']);
  });

  it('filters to the requested solverType and role=solution', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-sol', envelopeCid: 'env-sol' }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-verdict', envelopeCid: 'env-verdict', role: 'verdict' }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-other', envelopeCid: 'env-other', solverType: 'swe-rebench-v2.v1' }));

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload!.records.map((r) => r.envelopeCid)).toEqual(['env-sol']);
  });

  it('merges local served-artifact sha256s into records by envelopeCid', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-art', envelopeCid: 'env-art' }));
    store.saveServedArtifact({
      sha256: 'ab'.repeat(32),
      artifactType: 'prediction_v1_solution',
      envelopeCid: 'env-art',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date().toISOString(),
    });

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload!.records[0]!.artifacts).toEqual([
      expect.objectContaining({ sha256: 'ab'.repeat(32), artifactType: 'prediction_v1_solution' }),
    ]);
  });

  it('returns null (not a hang, not a throw) when the corpus query exceeds timeoutMs', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-slow', envelopeCid: 'env-slow' }));
    const hangingCorpus: ReadOnlyCorpus = {
      query: () => new Promise(() => { /* never resolves */ }),
      fetchManifest: () => Promise.reject(new Error('unused')),
    };
    const warnings: string[] = [];
    const payload = await loadCorpusKnowledge({
      corpus: hangingCorpus,
      store,
      solverType: 'prediction.v1',
      timeoutMs: 50,
      log: (msg) => warnings.push(msg),
    });
    expect(payload).toBeNull();
    expect(warnings.join('\n')).toContain('timed out');
  });

  it('returns null and logs when the corpus query throws', async () => {
    const throwingCorpus: ReadOnlyCorpus = {
      query: () => Promise.reject(new Error('boom')),
      fetchManifest: () => Promise.reject(new Error('unused')),
    };
    const warnings: string[] = [];
    const payload = await loadCorpusKnowledge({
      corpus: throwingCorpus,
      store,
      solverType: 'prediction.v1',
      log: (msg) => warnings.push(msg),
    });
    expect(payload).toBeNull();
    expect(warnings.join('\n')).toContain('boom');
  });
});
