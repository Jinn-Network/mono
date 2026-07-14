import { describe, expect, it } from 'vitest';
import { createJinnPlugin, EpisodeV1Schema } from '../../src/index.js';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../../src/testing.js';

describe('createJinnPlugin session → end smoke (AC5)', () => {
  it('completes a session on in-memory adapters and returns a schema-valid EpisodeV1', async () => {
    const evidence = new InMemoryEvidencePort();
    const plugin = createJinnPlugin({
      corpus: new InMemoryCorpusPort([{ ref: 'seed-1', kind: 'seed', title: 'Fixing flaky tests' }]),
      evidence,
      contribution: new InMemoryContributionPort(),
      localLearning: new InMemoryLocalLearningPort(),
      skills: new InMemorySkillsPort(),
    });

    const session = plugin.session({
      sessionId: 'sess-1',
      taskSummary: 'Fix a failing test',
      harness: { name: 'hermes', version: '0.1.0' },
      model: 'claude-test',
      tools: ['bash', 'edit'],
    });

    const pickup = await session.firstTurnPickup('how do I fix this flaky test?');
    expect(pickup.suggestions).toHaveLength(1);
    expect(pickup.markers).toContain('corpus');

    session.noteUserTurn('how do I fix this flaky test?');
    session.noteAssistantTurn('Let me check the failing assertion.');
    session.noteToolCall({
      spanId: 'span-1',
      parentSpanId: null,
      name: 'bash',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '2000000000',
      attributes: {},
    });

    const result = await session.end({
      status: 'completed',
      verifiabilityTier: 'user-accepted',
      durationMs: 1500,
      retentionPolicy: 'local-private',
    });

    expect(result.episodeRef).toBeTruthy();
    expect(result.eligibility).toEqual({
      eligible: false,
      reason: 'stage-1-stub',
      checkedAt: expect.any(String),
    });
    expect(result.summary.episodeRef).toBe(result.episodeRef);
    expect(result.summary.nothingFound).toBe(false);

    const stored = await evidence.get(result.episodeRef);
    expect(stored.status).toBe('ok');
    const episode = EpisodeV1Schema.parse(stored.status === 'ok' ? stored.value : undefined);
    expect(episode.schemaVersion).toBe('jinn.episode.v1');
    expect(episode.turns).toHaveLength(2);
    expect(episode.toolCalls).toHaveLength(1);
    expect(episode.outcome.status).toBe('completed');
  });
});
