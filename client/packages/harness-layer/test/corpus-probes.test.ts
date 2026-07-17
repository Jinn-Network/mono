import { describe, it, expect } from 'vitest';
import type { HarnessLayer, CorpusSearchHit } from '../src/consume.js';
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

/** A layer dep whose corpus.search returns fixed hits (or throws). Only `search` is needed. */
function makeFakeLayer({ hits = [], throwErr }: { hits?: CorpusSearchHit[]; throwErr?: Error } = {}): {
  corpus: { search: HarnessLayer['corpus']['search'] };
} {
  return {
    corpus: {
      async search() {
        if (throwErr) throw throwErr;
        return hits;
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
    const layer = makeFakeLayer({ hits: [fakeHit(), fakeHit(), fakeHit()] });
    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });
    const reachable = checkNamed(checks, 'corpus-reachable');
    expect(reachable.ok).toBe(true);
    expect(reachable.detail).toContain('3');
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
    const layer = makeFakeLayer({ hits: [fakeHit(), fakeHit(), fakeHit()] });
    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });
    const content = checkNamed(checks, 'corpus-content');
    expect(content.ok).toBe(true);
    expect('remedy' in content).toBe(false);
  });

  it('corpus-content NOT ok when hits.length < 3 — informational, no remedy key', async () => {
    const layer = makeFakeLayer({ hits: [fakeHit(), fakeHit()] });
    const checks = await corpusProbes({ layer, repoSlug: 'owner/repo' });
    const content = checkNamed(checks, 'corpus-content');
    expect(content.ok).toBe(false);
    expect('remedy' in content).toBe(false);
  });

  it('drift-guard: enoughCorpusForRepo flips exactly at CORPUS_ONBOARDING_K, and corpus-content.ok agrees', async () => {
    const kMinus1 = Array.from({ length: CORPUS_ONBOARDING_K - 1 }, () => fakeHit());
    const kExactly = Array.from({ length: CORPUS_ONBOARDING_K }, () => fakeHit());

    expect(enoughCorpusForRepo(kMinus1)).toBe(false);
    expect(enoughCorpusForRepo(kExactly)).toBe(true);

    // corpus-content.ok is the SAME predicate over the SAME hit counts — one source of truth.
    const below = await corpusProbes({ layer: makeFakeLayer({ hits: kMinus1 }), repoSlug: 'r' });
    const atK = await corpusProbes({ layer: makeFakeLayer({ hits: kExactly }), repoSlug: 'r' });
    expect(checkNamed(below, 'corpus-content').ok).toBe(false);
    expect(checkNamed(atK, 'corpus-content').ok).toBe(true);
  });
});
