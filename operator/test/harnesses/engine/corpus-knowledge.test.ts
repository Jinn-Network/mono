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

  it('falls back to store-only results (not null) when the corpus query exceeds timeoutMs and local knowledge exists (#1393 review finding 4)', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-slow', envelopeCid: 'env-slow' }));
    const hangingCorpus: ReadOnlyCorpus = {
      query: () => new Promise(() => { /* never resolves — no AbortSignal to cancel it */ }),
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
    // A sick network corpus must not deny local knowledge that IS available.
    expect(payload).not.toBeNull();
    expect(payload!.records.map((r) => r.envelopeCid)).toEqual(['env-slow']);
    expect(warnings.join('\n')).toContain('timed out');
    expect(warnings.join('\n')).toContain('falling back to store-only');
  });

  it('returns null when the corpus query exceeds timeoutMs and no local knowledge exists', async () => {
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

  it('backfills artifact refs for a ranked record even when its served-artifact row falls outside the local recency window (#1393 review finding 2)', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-target', envelopeCid: 'env-target', generatedAt: 1_000 }));
    store.saveServedArtifact({
      sha256: 'aa'.repeat(32),
      artifactType: 'prediction_v1_solution',
      envelopeCid: 'env-target',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date(1_000).toISOString(),
    });
    // Two unrelated, more-recent served-artifact rows push env-target's row
    // outside a naive top-N-by-recency local join when searchLimit is small.
    store.saveServedArtifact({
      sha256: 'bb'.repeat(32),
      artifactType: 'other_type',
      envelopeCid: 'env-unrelated-1',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date(3_000).toISOString(),
    });
    store.saveServedArtifact({
      sha256: 'cc'.repeat(32),
      artifactType: 'other_type',
      envelopeCid: 'env-unrelated-2',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date(2_000).toISOString(),
    });

    const payload = await loadCorpusKnowledge({
      corpus: null,
      store,
      solverType: 'prediction.v1',
      searchLimit: 2, // smaller than the 3 served-artifact rows above
    });
    expect(payload!.records).toHaveLength(1);
    expect(payload!.records[0]!.artifacts).toEqual([
      expect.objectContaining({ sha256: 'aa'.repeat(32), artifactType: 'prediction_v1_solution' }),
    ]);
  });

  it('does not truncate the ranking pool before the tier sort — an old attested record still wins over 14 newer self-signed ones (#1393 review finding 2)', async () => {
    for (let i = 0; i < 14; i += 1) {
      store.saveEnvelopeProjection(projection({
        envelopeId: `env-recent-${i}`,
        envelopeCid: `env-recent-${i}`,
        evidenceTier: 'self-signed',
        generatedAt: 14_000 - i * 1_000,
      }));
    }
    store.saveEnvelopeProjection(projection({
      envelopeId: 'env-old-attested',
      envelopeCid: 'env-old-attested',
      evidenceTier: 'attested',
      generatedAt: 1,
    }));

    // Default searchLimit (raised from the old 12) must still admit the
    // 15th-oldest record into the ranking pool.
    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload!.records[0]!.envelopeCid).toBe('env-old-attested');
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
