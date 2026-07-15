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
      corpus: new InMemoryCorpusPort([
        { ref: 'seed-1', kind: 'skill', title: 'flaky', snippet: 'Fixing flaky tests', tier: 'user-accepted', payloadKind: 'skill' },
      ]),
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

    const pickup = await session.firstTurnPickup('debug this flaky assertion');
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
      retentionPolicy: 'contribution-eligible',
      acceptedDiff: true,
    });

    expect(result.episodeRef).toBeTruthy();
    expect(result.eligibility.eligible).toBe(true);
    expect(result.eligibility.reason.length).toBeGreaterThan(0);
    expect(result.summary.episodeRef).toBe(result.episodeRef);
    expect(result.summary.nothingFound).toBe(false);
    expect(result.summary.surfacedRefs).toEqual(['seed-1']);
    expect(result.summary.fetchedRefs).toEqual(['seed-1']);

    const stored = await evidence.get(result.episodeRef);
    expect(stored.status).toBe('ok');
    const episode = EpisodeV1Schema.parse(stored.status === 'ok' ? stored.value : undefined);
    expect(episode.schemaVersion).toBe('jinn.episode.v1');
    expect(episode.trajectory.map((s) => s.kind)).toEqual([
      'jinn.agent_turn',
      'jinn.agent_turn',
      'jinn.tool_call',
    ]);
    expect(episode.trajectory.every((s) => s.spanId.length > 0)).toBe(true);
    expect(episode.outcome.status).toBe('completed');
    expect(episode.activity).toEqual({
      surfacedRefs: ['seed-1'],
      fetchedRefs: ['seed-1'],
      installedSkillRefs: [],
    });
    expect(episode.eligibility).toEqual(result.eligibility);
    expect(episode.eligibility?.checkedAt).toBe(episode.session.capturedAt);
  });

  it('end() fails loud on a session with no recorded turns (EpisodeV1Schema turns.min(1))', async () => {
    const plugin = createJinnPlugin({
      corpus: new InMemoryCorpusPort([]),
      evidence: new InMemoryEvidencePort(),
      contribution: new InMemoryContributionPort(),
      localLearning: new InMemoryLocalLearningPort(),
      skills: new InMemorySkillsPort(),
    });

    const session = plugin.session({
      sessionId: 'sess-empty',
      taskSummary: 'no turns recorded',
      harness: { name: 'hermes', version: '0.1.0' },
      model: 'claude-test',
      tools: ['bash'],
    });

    // No noteUserTurn / noteAssistantTurn — assembling the episode must throw,
    // not silently persist an invalid record. The throw is the intended contract.
    await expect(
      session.end({
        status: 'completed',
        verifiabilityTier: 'user-accepted',
        durationMs: 100,
        retentionPolicy: 'local-private',
      }),
    ).rejects.toThrow();
  });
});
