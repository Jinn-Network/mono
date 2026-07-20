import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { RETRIEVAL_VISIBLE_TAG } from '@jinn-network/plugin';
import type {
  HarnessLayer,
  CorpusRecord as WireCorpusRecord,
  CorpusSearchHit,
} from '../src/consume.js';
import type { TraceEnvelopeV0 } from '../src/envelope.js';
import { TRACE_ENVELOPE_ARTIFACT_TYPE } from '../src/publish.js';
import {
  corpusProbes,
  enoughCorpusForRepo,
  CORPUS_ONBOARDING_K,
} from '../src/corpus-probes.js';

function fakeHit(overrides: Partial<CorpusSearchHit> = {}): CorpusSearchHit {
  return {
    title: 'prediction.v1 / solution',
    ref: 'bafyPred',
    solverType: 'prediction.v1',
    role: 'solution',
    artifactTypes: ['output.prediction.v1'],
    kind: 'trace',
    evidenceTier: 'self-signed',
    generatedAt: 0,
    publishedAt: 0,
    operator: { agentId: '7', safeAddress: '0xabc' },
    task: null,
    ...overrides,
  };
}

function traceEnvelope(
  ref: string,
  tags: string[] = ['mono', RETRIEVAL_VISIBLE_TAG],
): TraceEnvelopeV0 {
  return {
    schemaVersion: 'jinn.trace-envelope.v0',
    session: { sessionId: `seed:${ref}`, capturedAt: '2026-07-04T00:00:00.000Z' },
    task: {
      summary: 'Fix the dashboard version-status flake',
      distributionTags: tags,
    },
    environment: {
      harness: { name: 'hermes-agent', version: '0.1.0' },
      model: 'test-model',
      tools: ['bash'],
    },
    steps: [
      {
        spanId: 's1',
        parentSpanId: null,
        name: 'run tests',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '2000000000',
        attributes: { 'tool.args': 'yarn test', 'tool.exitCode': 0 },
        redactedKeys: [],
      },
    ],
    outcome: {
      status: 'completed',
      verifiabilityTier: 'tests-passed',
      summary: 'The flake is fixed.',
    },
    cost: { durationMs: 1000 },
    consent: { contributionConsent: true, scrubCompleted: true },
    provenance: 'imported',
  };
}

function wireRecord(
  ref: string,
  tags: string[] = ['mono', RETRIEVAL_VISIBLE_TAG],
): WireCorpusRecord {
  const content = Buffer.from(JSON.stringify(traceEnvelope(ref, tags)), 'utf-8');
  return {
    ref,
    envelope: { participant: { safeAddress: '0xparticipant' } } as WireCorpusRecord['envelope'],
    provenance: {
      operator: { agentId: 'agent-77', safeAddress: '0xoperator' },
      evidenceTier: 'self-signed',
      publishedAt: 1_751_587_200,
    },
    artifacts: [
      {
        sha256: createHash('sha256').update(content).digest('hex'),
        artifactType: TRACE_ENVELOPE_ARTIFACT_TYPE,
        content,
        source: 'ipfs',
        sizeBytes: content.length,
      },
    ],
  };
}

interface FakeLayerOptions {
  hits?: CorpusSearchHit[];
  hitsForQuery?: (query: string) => CorpusSearchHit[];
  records?: Map<string, WireCorpusRecord>;
  throwErr?: Error;
  searchOptions?: Array<{ limit?: number; kind?: 'skill' | 'trace'; includeSuperseded?: boolean }>;
  searchQueries?: string[];
  fetchedRefs?: string[];
}

/** A layer dep whose corpus search/get paths are deterministic and network-free. */
function makeFakeLayer({
  hits = [],
  hitsForQuery,
  records = new Map(hits.map((hit) => [hit.ref, wireRecord(hit.ref)])),
  throwErr,
  searchOptions,
  searchQueries,
  fetchedRefs,
}: FakeLayerOptions = {}): HarnessLayer {
  return {
    config: {
      discoveryUrl: '',
      ipfsGatewayUrl: '',
      dbPath: '',
      captureMetaUrl: '',
    },
    corpus: {
      async search(query, opts) {
        if (throwErr) throw throwErr;
        searchQueries?.push(query);
        searchOptions?.push(opts ?? {});
        return (hitsForQuery?.(query) ?? hits).slice(0, opts?.limit);
      },
      async get(ref) {
        fetchedRefs?.push(ref);
        const record = records.get(ref);
        if (!record) throw new Error(`record not found: ${ref}`);
        return record;
      },
    },
  };
}

function checkNamed(checks: Awaited<ReturnType<typeof corpusProbes>>, name: string) {
  const check = checks.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  return check;
}

describe('corpusProbes', () => {
  it('corpus-reachable ok on a non-empty successful return', async () => {
    const layer = makeFakeLayer({ hits: [fakeHit({ ref: 'one' })] });
    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });
    const reachable = checkNamed(checks, 'corpus-reachable');
    expect(reachable.ok).toBe(true);
    expect(reachable.detail).toContain('1');
    expect('remedy' in reachable).toBe(false);
  });

  it('corpus-reachable ok on an EMPTY return — reachable/nothing-found, no remedy', async () => {
    const layer = makeFakeLayer({ hits: [] });
    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });
    const reachable = checkNamed(checks, 'corpus-reachable');
    expect(reachable.ok).toBe(true);
    expect(reachable.detail).toContain('0');
    expect('remedy' in reachable).toBe(false);
  });

  it('corpus-reachable NOT ok when search throws — resolves (does not throw), carries a remedy', async () => {
    const layer = makeFakeLayer({ throwErr: new Error('discovery unreachable') });
    // Assert corpusProbes RESOLVES rather than rejecting.
    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });
    const reachable = checkNamed(checks, 'corpus-reachable');
    expect(reachable.ok).toBe(false);
    expect(reachable.remedy).toBeDefined();
    expect(reachable.detail).toContain('discovery unreachable');
    // corpus-content is informational even on the unreachable path — no remedy.
    const content = checkNamed(checks, 'corpus-content');
    expect(content.ok).toBe(false);
    expect('remedy' in content).toBe(false);
  });

  it('corpus-content ok when hits.length >= 3', async () => {
    const layer = makeFakeLayer({
      hits: ['one', 'two', 'three'].map((ref) =>
        fakeHit({ ref, tags: ['mono', RETRIEVAL_VISIBLE_TAG] })),
    });
    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });
    const content = checkNamed(checks, 'corpus-content');
    expect(content.ok).toBe(true);
    expect('remedy' in content).toBe(false);
  });

  it('corpus-content NOT ok when hits.length < 3 — informational, no remedy key', async () => {
    const layer = makeFakeLayer({
      hits: ['one', 'two'].map((ref) =>
        fakeHit({ ref, tags: ['mono', RETRIEVAL_VISIBLE_TAG] })),
    });
    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });
    const content = checkNamed(checks, 'corpus-content');
    expect(content.ok).toBe(false);
    expect('remedy' in content).toBe(false);
  });

  it('does not count unmarked substrate records as corpus content', async () => {
    const fetchedRefs: string[] = [];
    const layer = makeFakeLayer({
      hits: ['one', 'two', 'three'].map((ref) => fakeHit({ ref, tags: ['mono'] })),
      fetchedRefs,
    });

    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });

    expect(checkNamed(checks, 'corpus-content').ok).toBe(false);
    expect(fetchedRefs).toEqual([]);
  });

  it('searches past unmarked candidates and counts only records admitted by both visibility guards', async () => {
    const searchOptions: FakeLayerOptions['searchOptions'] = [];
    const fetchedRefs: string[] = [];
    const hits = [
      fakeHit({ ref: 'substrate-1', tags: ['mono'] }),
      fakeHit({ ref: 'substrate-2', tags: ['mono'] }),
      fakeHit({ ref: 'substrate-3', tags: ['mono'] }),
      fakeHit({ ref: 'marked-1', tags: ['mono', RETRIEVAL_VISIBLE_TAG] }),
      fakeHit({ ref: 'marked-2', tags: ['mono', RETRIEVAL_VISIBLE_TAG] }),
      fakeHit({ ref: 'marked-3', tags: ['mono', RETRIEVAL_VISIBLE_TAG] }),
    ];

    const checks = await corpusProbes({
      layer: makeFakeLayer({ hits, searchOptions, fetchedRefs }),
      repoSlug: 'owner/repo',
    });

    expect(searchOptions[0]?.limit).toBeGreaterThan(CORPUS_ONBOARDING_K);
    expect(fetchedRefs).toEqual(['marked-1', 'marked-2', 'marked-3']);
    expect(checkNamed(checks, 'corpus-content')).toMatchObject({
      ok: true,
      detail: '3 retrieval-visible matching record(s)',
    });
  });

  it('uses pickup repo vocabulary — mono, not the raw Jinn-Network/mono slug — for the real probe query', async () => {
    const searchQueries: string[] = [];
    const markedHits = ['one', 'two', 'three'].map((ref) =>
      fakeHit({ ref, tags: ['mono', RETRIEVAL_VISIBLE_TAG] }));
    const records = new Map(markedHits.map((hit) => [hit.ref, wireRecord(hit.ref)]));
    const layer = makeFakeLayer({
      hitsForQuery: (query) => query === 'mono' ? markedHits : [],
      records,
      searchQueries,
    });

    const checks = await corpusProbes({
      layer,
      repoSlug: 'Jinn-Network/mono',
    });

    expect(searchQueries).toEqual(['mono']);
    expect(checkNamed(checks, 'corpus-content').ok).toBe(true);
  });

  it('does not count a search-marked hit when its canonical record content is unmarked', async () => {
    const hit = fakeHit({ ref: 'stale-search-mark', tags: ['mono', RETRIEVAL_VISIBLE_TAG] });
    const records = new Map([
      ['stale-search-mark', wireRecord('stale-search-mark', ['mono'])],
    ]);

    const checks = await corpusProbes({
      layer: makeFakeLayer({ hits: [hit], records }),
      repoSlug: 'owner/repo',
      k: 1,
    });

    expect(checkNamed(checks, 'corpus-content').ok).toBe(false);
  });

  it('does not count marked skill records as retrieval evidence', async () => {
    const hit = fakeHit({
      ref: 'marked-skill',
      kind: 'skill',
      tags: ['mono', RETRIEVAL_VISIBLE_TAG],
    });

    const checks = await corpusProbes({
      layer: makeFakeLayer({ hits: [hit] }),
      repoSlug: 'owner/repo',
      k: 1,
    });

    expect(checkNamed(checks, 'corpus-content').ok).toBe(false);
  });

  it('drift-guard: enoughCorpusForRepo flips exactly at CORPUS_ONBOARDING_K, and corpus-content.ok agrees for marked records', async () => {
    const refs = Array.from({ length: CORPUS_ONBOARDING_K }, (_, i) => `marked-${i}`);
    const markedHits = refs.map((ref) =>
      fakeHit({ ref, tags: ['mono', RETRIEVAL_VISIBLE_TAG] }));
    const kMinus1 = markedHits.slice(0, CORPUS_ONBOARDING_K - 1);
    const kExactly = markedHits;

    expect(enoughCorpusForRepo(kMinus1)).toBe(false);
    expect(enoughCorpusForRepo(kExactly)).toBe(true);

    // corpus-content.ok is the SAME predicate over the SAME hit counts — one source of truth.
    const below = await corpusProbes({
      layer: makeFakeLayer({ hits: kMinus1 }),
      repoSlug: 'owner/repo',
    });
    const atK = await corpusProbes({
      layer: makeFakeLayer({ hits: kExactly }),
      repoSlug: 'owner/repo',
    });
    expect(checkNamed(below, 'corpus-content').ok).toBe(false);
    expect(checkNamed(atK, 'corpus-content').ok).toBe(true);
  });
});
