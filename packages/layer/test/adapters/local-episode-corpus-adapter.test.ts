import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  degraded,
  unavailable,
  type EpisodeV1,
  type EvidencePort,
} from '@jinn-network/plugin';
import { InMemoryEvidencePort } from '@jinn-network/plugin/testing';
import { createEvidenceAdapter } from '@jinn-network/core';
import {
  createLocalEpisodeCorpusAdapter,
  localEpisodeRef,
} from '../../src/adapters/local-episode-corpus-adapter.js';

function makeEpisode(overrides: Partial<EpisodeV1> = {}): EpisodeV1 {
  return {
    schemaVersion: 'jinn.episode.v1',
    episodeId: 'episode:fixture',
    retrievalVisible: false,
    session: {
      sessionId: 'session:fixture',
      capturedAt: '2026-07-23T12:00:00.000Z',
      kind: 'user',
    },
    origin: { writer: 'vitest', build: '0.1.0' },
    task: { summary: 'Fixture task', distributionTags: [] },
    trajectory: [{
      spanId: 'turn-1',
      parentSpanId: null,
      kind: 'jinn.agent_turn',
      name: 'turn',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '1000000000',
      attributes: {},
      redactedKeys: [],
    }],
    environment: {
      harness: { name: 'vitest', version: '0.1.0' },
      model: 'test',
      tools: [],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verificationStrength: 'user-accepted' },
    cost: { durationMs: 1 },
    retention: { policy: 'local-private' },
    provenance: 'imported',
    ...overrides,
  };
}

const episode = makeEpisode({
  episodeId: 'episode/local:1',
  retrievalVisible: false,
  task: {
    summary: 'Fix Dashboard Version Status',
    distributionTags: ['Vitest', 'Async'],
  },
  outcome: {
    status: 'completed',
    verificationStrength: 'tests-passed',
  },
});

function countingEvidence(backing: InMemoryEvidencePort): {
  evidence: EvidencePort;
  listCalls: () => number;
} {
  let calls = 0;
  return {
    evidence: {
      put: (value) => backing.put(value),
      get: (episodeId) => backing.get(episodeId),
      list: (query) => {
        calls += 1;
        return backing.list(query);
      },
      retention: () => backing.retention(),
    },
    listCalls: () => calls,
  };
}

describe('LocalEpisodeCorpusAdapter', () => {
  it('searches summary and tags case-insensitively and projects every local hit visible', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(episode);
    const adapter = createLocalEpisodeCorpusAdapter({ evidence });

    const bySummary = await adapter.search('dAsHbOaRd');
    const byTag = await adapter.search('aSyNc');

    expect(bySummary.status).toBe('ok');
    expect(byTag.status).toBe('ok');
    if (bySummary.status !== 'ok') return;
    const [hit] = bySummary.value;
    expect(hit).toMatchObject({
      ref: `local-episode:${encodeURIComponent('episode/local:1')}`,
      canonicalEpisodeId: 'episode/local:1',
      kind: 'trace',
      snippet: 'Fix Dashboard Version Status',
      tags: ['Vitest', 'Async'],
      tier: 'tests-passed',
      origin: 'local:episode/local:1',
      recencyDomain: 'unix-ms',
      retrievalVisible: true,
    });
    expect(hit?.publishedAt).toBe(Date.parse(episode.session.capturedAt));
    if (byTag.status === 'ok') expect(byTag.value).toHaveLength(1);
  });

  it('shares one evidence.list call across concurrent term searches', async () => {
    const backing = new InMemoryEvidencePort();
    await backing.put(episode);
    const { evidence, listCalls } = countingEvidence(backing);
    const adapter = createLocalEpisodeCorpusAdapter({ evidence });

    await Promise.all([
      adapter.search('dashboard'),
      adapter.search('vitest'),
      adapter.search('async'),
    ]);

    expect(listCalls()).toBe(1);
  });

  it('routes an encoded local ref through evidence.get', async () => {
    const backing = new InMemoryEvidencePort();
    await backing.put(episode);
    const requested: string[] = [];
    const evidence: EvidencePort = {
      put: (value) => backing.put(value),
      get: (episodeId) => {
        requested.push(episodeId);
        return backing.get(episodeId);
      },
      list: (query) => backing.list(query),
      retention: () => backing.retention(),
    };
    const adapter = createLocalEpisodeCorpusAdapter({ evidence });

    const result = await adapter.get(localEpisodeRef(episode.episodeId));

    expect(requested).toEqual(['episode/local:1']);
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        ref: localEpisodeRef(episode.episodeId),
        canonicalEpisodeId: episode.episodeId,
        origin: 'local:episode/local:1',
        retrievalVisible: true,
      },
    });
  });

  it('keeps valid list values when EvidencePort is degraded', async () => {
    const evidence: EvidencePort = {
      put: async () => ({ status: 'ok', value: { episodeId: episode.episodeId } }),
      get: async () => ({ status: 'ok', value: null }),
      list: async () => degraded('stale cache', [episode]),
      retention: async () => ({ status: 'ok', value: { policy: 'local-private', maxEpisodes: 200 } }),
    };

    const result = await createLocalEpisodeCorpusAdapter({ evidence }).search('dashboard');

    expect(result).toMatchObject({
      status: 'degraded',
      reason: 'local corpus: stale cache',
      value: [{ canonicalEpisodeId: episode.episodeId, retrievalVisible: true }],
    });
  });

  it('propagates unavailable and degraded get outcomes with local-source reasons', async () => {
    const unavailableEvidence: EvidencePort = {
      put: async () => ({ status: 'ok', value: { episodeId: episode.episodeId } }),
      get: async () => unavailable('offline'),
      list: async () => ({ status: 'ok', value: [] }),
      retention: async () => ({ status: 'ok', value: { policy: 'local-private', maxEpisodes: 200 } }),
    };
    const degradedEvidence: EvidencePort = {
      ...unavailableEvidence,
      get: async () => degraded('stale record', episode),
    };

    await expect(
      createLocalEpisodeCorpusAdapter({ evidence: unavailableEvidence }).get(localEpisodeRef(episode.episodeId)),
    ).resolves.toEqual({ status: 'unavailable', reason: 'local corpus: offline' });
    await expect(
      createLocalEpisodeCorpusAdapter({ evidence: degradedEvidence }).get(localEpisodeRef(episode.episodeId)),
    ).resolves.toMatchObject({
      status: 'degraded',
      reason: 'local corpus: stale record',
      value: { retrievalVisible: true },
    });
  });

  it('does not mutate the stored EpisodeV1 retrievalVisible field', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(episode);
    const adapter = createLocalEpisodeCorpusAdapter({ evidence });

    await adapter.search('dashboard');
    await adapter.get(localEpisodeRef(episode.episodeId));

    expect(episode.retrievalVisible).toBe(false);
    await expect(evidence.get(episode.episodeId)).resolves.toMatchObject({
      status: 'ok',
      value: { retrievalVisible: false },
    });
  });

  it('fetches a legacy list-only capture advertised by local search without rewriting storage', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'jinn-local-legacy-'));
    const legacyPath = join(capturesDir, 'legacy-capture.json');
    writeFileSync(legacyPath, JSON.stringify({
      session: {
        sessionId: 'legacy-list-only',
        capturedAt: '2026-07-13T00:00:00.000Z',
      },
      task: {
        summary: 'Fix legacy dashboard failure',
        distributionTags: ['dashboard'],
      },
      environment: {
        harness: { name: 'hermes', version: '1.0.0' },
        model: 'test',
        tools: ['terminal'],
      },
      steps: [{
        spanId: 'legacy-turn-1',
        parentSpanId: null,
        name: 'jinn.transcript.user-message',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '1000000000',
        attributes: {
          'jinn.capture.event.kind': 'user-message',
          'message.content': 'fix it',
        },
        redactedKeys: [],
      }],
      outcome: {
        status: 'completed',
        verifiabilityTier: 'tests-passed',
      },
      cost: { durationMs: 1 },
      provenance: 'contributed',
    }), 'utf8');
    const before = readFileSync(legacyPath, 'utf8');
    const adapter = createLocalEpisodeCorpusAdapter({
      evidence: createEvidenceAdapter({ capturesDir }),
    });

    const searched = await adapter.search('dashboard');
    expect(searched.status).toBe('ok');
    if (searched.status !== 'ok') return;
    expect(searched.value).toHaveLength(1);

    const fetched = await adapter.get(searched.value[0]!.ref);

    expect(fetched).toMatchObject({
      status: 'ok',
      value: {
        canonicalEpisodeId: 'legacy-list-only',
        task: { summary: 'Fix legacy dashboard failure' },
        retrievalVisible: true,
      },
    });
    expect(readFileSync(legacyPath, 'utf8')).toBe(before);
  });

  it('degrades and excludes an ambiguous duplicate local episode identity', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'jinn-local-duplicate-'));
    const duplicateId = 'duplicate-episode';
    writeFileSync(join(capturesDir, `${duplicateId}.episode.json`), JSON.stringify(makeEpisode({
      episodeId: duplicateId,
      task: { summary: 'Canonical unrelated capture', distributionTags: [] },
    })), 'utf8');
    writeFileSync(join(capturesDir, 'legacy-capture.json'), JSON.stringify({
      session: {
        sessionId: duplicateId,
        capturedAt: '2026-07-13T00:00:00.000Z',
      },
      task: {
        summary: 'Legacy duplicate retrieval phrase',
        distributionTags: ['duplicate'],
      },
      environment: {
        harness: { name: 'hermes', version: '1.0.0' },
        model: 'test',
        tools: ['terminal'],
      },
      steps: [{
        spanId: 'legacy-turn-1',
        parentSpanId: null,
        name: 'jinn.transcript.user-message',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '1000000000',
        attributes: {
          'jinn.capture.event.kind': 'user-message',
          'message.content': 'fix it',
        },
        redactedKeys: [],
      }],
      outcome: {
        status: 'completed',
        verifiabilityTier: 'tests-passed',
      },
      cost: { durationMs: 1 },
      provenance: 'contributed',
    }), 'utf8');
    const adapter = createLocalEpisodeCorpusAdapter({
      evidence: createEvidenceAdapter({ capturesDir }),
    });

    const directFetched = await adapter.get(localEpisodeRef(duplicateId));
    const searched = await adapter.search('retrieval phrase');
    const fetched = await adapter.get(localEpisodeRef(duplicateId));

    expect(directFetched).toMatchObject({
      status: 'degraded',
      reason: expect.stringContaining(duplicateId),
      value: null,
    });
    expect(searched).toMatchObject({
      status: 'degraded',
      reason: expect.stringContaining(duplicateId),
      value: [],
    });
    expect(fetched).toMatchObject({
      status: 'degraded',
      reason: expect.stringContaining(duplicateId),
      value: null,
    });
  });
});
