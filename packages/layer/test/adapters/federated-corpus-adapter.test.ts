import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  degraded,
  ok,
  unavailable,
  type CorpusPort,
  type CorpusRecord,
  type KnowledgeHit,
  type PortResult,
} from '@jinn-network/plugin';
import { createFederatedCorpusAdapter } from '../../src/adapters/federated-corpus-adapter.js';
import { localEpisodeRef } from '../../src/adapters/local-episode-corpus-adapter.js';

const localHit: KnowledgeHit = {
  ref: 'local-episode:local-1',
  kind: 'trace',
  tags: [],
};
const publicHit: KnowledgeHit = { ref: 'public-1', kind: 'trace', tags: [] };

function makePort(
  search: (query: string) => Promise<PortResult<KnowledgeHit[]>> = async () => ok([]),
  get: (ref: string) => Promise<PortResult<CorpusRecord | null>> = async () => ok(null),
): CorpusPort & {
  search: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  return { search: vi.fn(search), get: vi.fn(get) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FederatedCorpusAdapter', () => {
  it.each([
    ['ok + ok', ok([localHit]), ok([publicHit]), 'ok', [localHit, publicHit]],
    ['degraded + ok', degraded('stale', [localHit]), ok([publicHit]), 'degraded', [localHit, publicHit]],
    ['unavailable + ok', unavailable('missing'), ok([publicHit]), 'degraded', [publicHit]],
    ['degraded + unavailable', degraded('partial', [localHit]), unavailable('offline'), 'degraded', [localHit]],
    ['unavailable + unavailable', unavailable('missing'), unavailable('offline'), 'unavailable', []],
  ] as const)('%s returns the merged status and values', async (
    _name,
    localResult,
    publicResult,
    status,
    expectedHits,
  ) => {
    const local = makePort(async () => localResult);
    const publicCorpus = makePort(async () => publicResult);

    const result = await createFederatedCorpusAdapter({ local, public: publicCorpus }).search('query');

    expect(result.status).toBe(status);
    expect(result.status === 'unavailable' ? [] : result.value ?? []).toEqual(expectedHits);
  });

  it('searches both children concurrently and preserves local-then-public order', async () => {
    let resolveLocal: (value: PortResult<KnowledgeHit[]>) => void = () => undefined;
    let resolvePublic: (value: PortResult<KnowledgeHit[]>) => void = () => undefined;
    const local = makePort(() => new Promise((resolve) => { resolveLocal = resolve; }));
    const publicCorpus = makePort(() => new Promise((resolve) => { resolvePublic = resolve; }));
    const adapter = createFederatedCorpusAdapter({ local, public: publicCorpus });

    const search = adapter.search('query');
    expect(local.search).toHaveBeenCalledWith('query');
    expect(publicCorpus.search).toHaveBeenCalledWith('query');
    resolvePublic(ok([publicHit]));
    resolveLocal(ok([localHit]));

    await expect(search).resolves.toEqual(ok([localHit, publicHit]));
  });

  it('deduplicates exact refs without ranking or visibility filtering', async () => {
    const duplicate: KnowledgeHit = { ...localHit, retrievalVisible: false };
    const local = makePort(async () => ok([duplicate]));
    const publicCorpus = makePort(async () => ok([
      { ...duplicate, title: 'public duplicate', retrievalVisible: true },
      { ...publicHit, score: 0 },
    ]));

    await expect(
      createFederatedCorpusAdapter({ local, public: publicCorpus }).search('query'),
    ).resolves.toEqual(ok([duplicate, { ...publicHit, score: 0 }]));
  });

  it('routes local-episode refs only to local and all other refs only to public', async () => {
    const local = makePort();
    const publicCorpus = makePort();
    const adapter = createFederatedCorpusAdapter({ local, public: publicCorpus });

    await adapter.get(localEpisodeRef('episode/local'));
    await adapter.get('bafy-public');

    expect(local.get).toHaveBeenCalledTimes(1);
    expect(local.get).toHaveBeenCalledWith(localEpisodeRef('episode/local'));
    expect(publicCorpus.get).toHaveBeenCalledTimes(1);
    expect(publicCorpus.get).toHaveBeenCalledWith('bafy-public');
  });

  it('times out one child while retaining the healthy child value', async () => {
    vi.useFakeTimers();
    const local = makePort(() => new Promise(() => undefined));
    const publicCorpus = makePort(async () => ok([publicHit]));
    const adapter = createFederatedCorpusAdapter({ local, public: publicCorpus, timeoutMs: 10 });

    const search = adapter.search('query');
    await vi.advanceTimersByTimeAsync(10);

    await expect(search).resolves.toEqual(degraded('local corpus: local corpus timed out after 10ms', [publicHit]));
  });

  it('allows a healthy cold public search to finish after five seconds by default', async () => {
    vi.useFakeTimers();
    const local = makePort(async () => ok([]));
    const publicCorpus = makePort(() => new Promise((resolve) => {
      setTimeout(() => resolve(ok([publicHit])), 7_000);
    }));
    const adapter = createFederatedCorpusAdapter({ local, public: publicCorpus });

    let settled = false;
    const search = adapter.search('query').finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(search).resolves.toEqual(ok([publicHit]));
  });

  it('opens the timed-out child circuit for later search and get calls', async () => {
    vi.useFakeTimers();
    let rejectLocal!: (error: Error) => void;
    const local = makePort(() => new Promise((_resolve, reject) => { rejectLocal = reject; }));
    const publicCorpus = makePort(async () => ok([publicHit]));
    const adapter = createFederatedCorpusAdapter({ local, public: publicCorpus, timeoutMs: 10 });

    const firstSearch = adapter.search('query');
    await vi.advanceTimersByTimeAsync(10);
    await firstSearch;
    rejectLocal(new Error('late failure'));
    await Promise.resolve();

    await expect(adapter.search('query')).resolves.toEqual(
      degraded('local corpus: local corpus circuit open after timeout', [publicHit]),
    );
    await expect(adapter.get(localEpisodeRef('episode/local'))).resolves.toEqual(
      unavailable('local corpus circuit open after timeout'),
    );
    expect(local.search).toHaveBeenCalledTimes(1);
    expect(local.get).not.toHaveBeenCalled();
  });
});
