import { describe, expect, it } from 'vitest';
import {
  EpisodeV1Schema,
  EpisodeV1WriteSchema,
} from '../../src/schemas/episode.js';
import { makeSampleEpisode } from '../_fixtures/episode.js';

const valid = makeSampleEpisode({ episodeId: 'ep-1' });

describe('EpisodeV1Schema', () => {
  it('parses a valid episode', () => {
    const parsed = EpisodeV1Schema.parse(valid);
    expect(parsed.episodeId).toBe('ep-1');
    expect(parsed.trajectory).toHaveLength(3);
    expect(parsed.trajectory.filter((s) => s.kind === 'jinn.agent_turn')).toHaveLength(2);
    expect(parsed.trajectory.filter((s) => s.kind === 'jinn.tool_call')).toHaveLength(1);
  });

  it('rejects an episode with an unknown top-level field (strict)', () => {
    expect(() => EpisodeV1WriteSchema.parse({
      ...valid,
      session: { ...valid.session, kind: 'user' },
      origin: { writer: 'test-writer', build: 'test-build' },
      extra: true,
    })).toThrow();
  });

  it('normalizes legacy optional nulls and delivery aliases on tolerant reads', () => {
    const parsed = EpisodeV1Schema.parse({
      ...valid,
      session: { ...valid.session, parentSessionId: null },
      task: { ...valid.task, repositorySlug: null },
      outcome: {
        ...valid.outcome,
        summary: null,
        acceptedDiff: null,
        testRuns: null,
      },
      cost: { ...valid.cost, tokens: null, usdEstimate: null },
      activity: {
        searchedTerms: ['dashboard'],
        providedRefs: ['bafy-delivered'],
        deliveredContentHash: null,
      },
      eligibility: null,
      lineage: null,
      futureAdditiveField: { preserved: true },
    });

    expect(parsed.session.kind).toBe('user');
    expect(parsed.session).not.toHaveProperty('parentSessionId');
    expect(parsed.origin).toBe('legacy-unstamped');
    expect(parsed.task).not.toHaveProperty('repositorySlug');
    expect(parsed.outcome).not.toHaveProperty('summary');
    expect(parsed.outcome).not.toHaveProperty('acceptedDiff');
    expect(parsed.outcome).not.toHaveProperty('testRuns');
    expect(parsed.cost).not.toHaveProperty('tokens');
    expect(parsed.cost).not.toHaveProperty('usdEstimate');
    expect(parsed.activity).toMatchObject({
      retrievalFired: true,
      eligibleRefs: ['bafy-delivered'],
      deliveredRefs: ['bafy-delivered'],
      deliveryMode: 'delivered',
      providedRefs: ['bafy-delivered'],
    });
    expect(parsed.activity).not.toHaveProperty('deliveredContentHash');
    expect(parsed).not.toHaveProperty('eligibility');
    expect(parsed).not.toHaveProperty('lineage');
    expect(parsed.futureAdditiveField).toEqual({ preserved: true });
  });

  it('requires explicit writer and v1.1 session/delivery facts on strict writes', () => {
    const next = {
      ...valid,
      session: {
        ...valid.session,
        kind: 'host-internal' as const,
        parentSessionId: 'parent-session',
      },
      origin: { writer: 'jinn-agent', build: '0.18.0' },
      task: { ...valid.task, repositorySlug: 'Jinn-Network/mono' },
      outcome: {
        ...valid.outcome,
        acceptedDiff: true,
        testRuns: { passed: 2, failed: 1 },
      },
      activity: {
        retrievalFired: true,
        eligibleRefs: ['bafy-eligible'],
        deliveredRefs: ['bafy-delivered'],
        deliveryMode: 'delivered' as const,
        deliveredContentHash: `sha256:${'a'.repeat(64)}`,
        searchedTerms: ['dashboard'],
        providedRefs: ['bafy-delivered'],
        surfacedRefs: [],
        fetchedRefs: ['bafy-delivered'],
        installedSkillRefs: [],
      },
    };

    expect(EpisodeV1WriteSchema.parse(next)).toEqual(next);
    expect(() => EpisodeV1WriteSchema.parse({
      ...next,
      task: { ...next.task, repositorySlug: null },
    })).toThrow();
  });

  it('rejects an empty trajectory', () => {
    expect(() => EpisodeV1Schema.parse({ ...valid, trajectory: [] })).toThrow();
  });

  it('allows a trajectory of only agent-turn steps (zero tool calls)', () => {
    const turnsOnly = valid.trajectory.filter((s) => s.kind === 'jinn.agent_turn');
    expect(() => EpisodeV1Schema.parse({ ...valid, trajectory: turnsOnly })).not.toThrow();
  });

  it('accepts an optional cost.usdEstimate string', () => {
    expect(() =>
      EpisodeV1Schema.parse({ ...valid, cost: { ...valid.cost, usdEstimate: '0.42' } }),
    ).not.toThrow();
  });

  it('rejects a non-numeric cost.usdEstimate', () => {
    expect(() =>
      EpisodeV1Schema.parse({ ...valid, cost: { ...valid.cost, usdEstimate: 'abc' } }),
    ).toThrow();
  });

  it('accepts an optional lineage block', () => {
    const withLineage = { ...valid, lineage: { episodeId: 'ep-0', mintRef: 'mint-1' } };
    expect(EpisodeV1Schema.parse(withLineage).lineage?.mintRef).toBe('mint-1');
  });

  it('persists strict evidence-first session activity facts and an authoritative eligibility verdict', () => {
    const enriched = {
      ...valid,
      activity: {
        searchedTerms: ['dashboard', 'vitest'],
        providedRefs: ['knowledge/provided-1'],
        surfacedRefs: [],
        fetchedRefs: ['knowledge/provided-1'],
        installedSkillRefs: [],
      },
      eligibility: {
        eligible: true,
        reason: 'accepted diff on a public repository',
        checkedAt: '2026-07-15T12:00:00.000Z',
      },
    };

    const parsed = EpisodeV1Schema.parse(enriched);

    expect(parsed.activity).toEqual({
      ...enriched.activity,
      retrievalFired: true,
      eligibleRefs: ['knowledge/provided-1'],
      deliveredRefs: ['knowledge/provided-1'],
      deliveryMode: 'delivered',
    });
    expect(parsed.eligibility).toEqual(enriched.eligibility);
  });

  it('accepts a pre-rescope (legacy) activity shape lacking searchedTerms/providedRefs, defaulting them to []', () => {
    const legacy = {
      ...valid,
      activity: {
        surfacedRefs: ['knowledge/surfaced-1'],
        fetchedRefs: ['knowledge/fetched-1'],
        installedSkillRefs: ['skills/testing@1'],
      },
    };

    const parsed = EpisodeV1Schema.parse(legacy);

    expect(parsed.activity).toEqual({
      searchedTerms: [],
      providedRefs: [],
      surfacedRefs: ['knowledge/surfaced-1'],
      fetchedRefs: ['knowledge/fetched-1'],
      installedSkillRefs: ['skills/testing@1'],
      retrievalFired: false,
      eligibleRefs: [],
      deliveredRefs: [],
      deliveryMode: 'disabled',
    });
  });

  it('rejects unknown persisted activity facts on strict writes', () => {
    expect(() => EpisodeV1WriteSchema.parse({
      ...valid,
      session: { ...valid.session, kind: 'user' },
      origin: { writer: 'test-writer', build: 'test-build' },
      activity: {
        retrievalFired: false,
        eligibleRefs: [],
        deliveredRefs: [],
        deliveryMode: 'disabled',
        searchedTerms: [],
        providedRefs: [],
        surfacedRefs: [],
        fetchedRefs: [],
        installedSkillRefs: [],
        privatePrompt: 'must never be persisted here',
      },
    })).toThrow();
  });

  // Cross-runtime contract guard (mono #1662): the Python plugin's
  // capture_buffer.assemble_episode() is the sole producer of this record; if its
  // emitted shape drifts from EpisodeV1Schema, the network drops real traces. The
  // two fixtures below are verbatim assemble_episode() output (a full user→tool→
  // assistant episode and a turn-only, no-tokens episode) — parsing them through
  // the strict schema pins the producer↔schema contract.
  it('parses a real assemble_episode full-trajectory output', () => {
    const fromPython = {
      schemaVersion: 'jinn.episode.v1',
      episodeId: 's-1784073615851964000',
      session: { sessionId: 's', capturedAt: '2026-07-15T00:00:15.851854Z' },
      task: { summary: 'fix the retry bug', distributionTags: [] },
      trajectory: [
        {
          spanId: 'turn-1',
          parentSpanId: null,
          kind: 'jinn.agent_turn',
          name: 'turn:user',
          startTimeUnixNano: '1784073615851967000',
          endTimeUnixNano: '1784073615851967000',
          attributes: { 'turn.text': 'fix the retry bug', role: 'user' },
          redactedKeys: [],
        },
        {
          spanId: 'c1',
          parentSpanId: null,
          kind: 'jinn.tool_call',
          name: 'tool:edit',
          startTimeUnixNano: '1784073615846972000',
          endTimeUnixNano: '1784073615851972000',
          attributes: { 'tool.args': { path: 'x' }, 'tool.result': 'ok' },
          redactedKeys: [],
        },
        {
          spanId: 'turn-2',
          parentSpanId: null,
          kind: 'jinn.agent_turn',
          name: 'turn:assistant',
          startTimeUnixNano: '1784073615851975000',
          endTimeUnixNano: '1784073615851975000',
          attributes: { 'turn.text': 'fixed it', role: 'assistant' },
          redactedKeys: [],
        },
      ],
      environment: {
        harness: { name: 'hermes-agent', version: '0.1.0' },
        model: 'gpt-4o-mini',
        tools: ['edit'],
        skillsLoadout: ['tdd', 'debugging'],
      },
      outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
      cost: { durationMs: 0, tokens: { input: 100, output: 50 } },
      retention: { policy: 'local-private' },
      provenance: 'contributed',
    };
    expect(() => EpisodeV1Schema.parse(fromPython)).not.toThrow();
  });

  it('parses a real assemble_episode turn-only output (no tool calls, cost.tokens omitted)', () => {
    const fromPython = {
      schemaVersion: 'jinn.episode.v1',
      episodeId: 't-1784073615852046000',
      session: { sessionId: 't', capturedAt: '2026-07-15T00:00:15.852044Z' },
      task: { summary: 'just a question', distributionTags: [] },
      trajectory: [
        {
          spanId: 'turn-1',
          parentSpanId: null,
          kind: 'jinn.agent_turn',
          name: 'turn:user',
          startTimeUnixNano: '1784073615852047000',
          endTimeUnixNano: '1784073615852047000',
          attributes: { 'turn.text': 'just a question', role: 'user' },
          redactedKeys: [],
        },
        {
          spanId: 'turn-2',
          parentSpanId: null,
          kind: 'jinn.agent_turn',
          name: 'turn:assistant',
          startTimeUnixNano: '1784073615852049000',
          endTimeUnixNano: '1784073615852049000',
          attributes: { 'turn.text': 'here is the answer', role: 'assistant' },
          redactedKeys: [],
        },
      ],
      environment: {
        harness: { name: 'hermes-agent', version: '0.1.0' },
        model: 'gpt-4o-mini',
        tools: [],
        skillsLoadout: [],
      },
      outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
      cost: { durationMs: 0 },
      retention: { policy: 'contribution-eligible' },
      provenance: 'contributed',
    };
    expect(() => EpisodeV1Schema.parse(fromPython)).not.toThrow();
  });
});
