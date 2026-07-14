import { describe, expect, it } from 'vitest';
import { createJinnPlugin } from '../../src/index.js';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../../src/testing.js';
import type { EvidencePort } from '../../src/ports/evidence-port.js';
import type { EpisodeV1 } from '../../src/schemas/episode.js';

function makeSession(evidence: EvidencePort) {
  const plugin = createJinnPlugin({
    corpus: new InMemoryCorpusPort([]),
    evidence,
    contribution: new InMemoryContributionPort(),
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
  });
  const session = plugin.session({
    sessionId: 'sess-persist',
    taskSummary: 'Fix a failing test',
    harness: { name: 'hermes', version: '0.1.0' },
    model: 'claude-test',
    tools: ['bash'],
  });
  session.noteUserTurn('help');
  session.noteAssistantTurn('sure');
  return session;
}

const OUTCOME = {
  status: 'completed' as const,
  verifiabilityTier: 'user-accepted' as const,
  durationMs: 1000,
  retentionPolicy: 'local-private' as const,
};

/** An EvidencePort whose only interesting behavior is its `put` result. */
function evidenceWithPut(put: EvidencePort['put']): EvidencePort {
  return {
    put,
    async get() {
      return { status: 'ok', value: null };
    },
    async list() {
      return { status: 'ok', value: [] };
    },
    async retention() {
      return { status: 'ok', value: { policy: 'local-private', maxEpisodes: 200 } };
    },
  };
}

describe('PluginSession.end() surfaces the persistence outcome (#1696 AC2)', () => {
  it('reports persistence.status === "ok" when evidence.put succeeds', async () => {
    const result = await makeSession(new InMemoryEvidencePort()).end(OUTCOME);
    expect(result.persistence.status).toBe('ok');
    if (result.persistence.status === 'ok') {
      expect(result.persistence.value.episodeId).toBe(result.episodeRef);
    }
  });

  it('surfaces a degraded put instead of reporting plain success', async () => {
    const evidence = evidenceWithPut(async (episode: EpisodeV1) => ({
      status: 'degraded',
      reason: 'buffered offline',
      value: { episodeId: episode.episodeId },
    }));
    const result = await makeSession(evidence).end(OUTCOME);
    expect(result.persistence.status).toBe('degraded');
  });

  it('surfaces an unavailable put instead of reporting plain success', async () => {
    const evidence = evidenceWithPut(async () => ({ status: 'unavailable', reason: 'store offline' }));
    const result = await makeSession(evidence).end(OUTCOME);
    expect(result.persistence.status).toBe('unavailable');
    expect(result.episodeRef).toBeTruthy();
  });
});
