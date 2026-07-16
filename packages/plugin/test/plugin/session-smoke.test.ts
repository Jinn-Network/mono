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
      corpus: new InMemoryCorpusPort([{
        ref: 'seed-1',
        kind: 'trace',
        task: { summary: 'Fixing a flaky assertion in the debug harness' },
        outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
        steps: [{ name: 'fix', attributes: { 'tool.args': 'retry with a longer timeout', 'tool.exitCode': 0 } }],
        tags: ['flaky', 'assertion', 'debug'],
        provenance: 'imported',
        origin: 'seed:flaky-assertion',
        capturedAt: '2026-07-10T00:00:00.000Z',
        tier: 'tests-passed',
      }]),
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
    expect(pickup.packets).toHaveLength(1);
    expect(pickup.packets[0]?.ref).toBe('seed-1');
    expect(pickup.contextBlock).toContain('[jinn corpus] Prior evidence relevant to this task:');

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
    expect(result.summary.searchedTerms.length).toBeGreaterThan(0);
    expect(result.summary.providedPackets).toEqual([{ ref: 'seed-1', title: 'Fixing a flaky assertion in the debug harness' }]);
    // Legacy fields stay populated for compatibility (rescope §3.6).
    expect(result.summary.surfacedRefs).toEqual(['seed-1']);
    expect(result.summary.fetchedRefs).toEqual(['seed-1']);
    expect(result.summary.installedSkillRefs).toEqual([]);

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
    expect(episode.activity?.providedRefs).toEqual(['seed-1']);
    expect(episode.activity?.fetchedRefs).toEqual(['seed-1']);
    expect(episode.activity?.installedSkillRefs).toEqual([]);
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
