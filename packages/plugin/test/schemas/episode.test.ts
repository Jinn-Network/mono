import { describe, expect, it } from 'vitest';
import { EpisodeV1Schema, parseEpisodeV1Read } from '../../src/schemas/episode.js';
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
    expect(() => EpisodeV1Schema.parse({ ...valid, extra: true })).toThrow();
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

  it('persists strict optional session activity facts and an authoritative eligibility verdict', () => {
    const enriched = {
      ...valid,
      activity: {
        surfacedRefs: ['knowledge/surfaced-1'],
        fetchedRefs: ['knowledge/fetched-1'],
        installedSkillRefs: ['skills/testing@1'],
      },
      eligibility: {
        eligible: true,
        reason: 'accepted diff on a public repository',
        checkedAt: '2026-07-15T12:00:00.000Z',
      },
    };

    const parsed = EpisodeV1Schema.parse(enriched);

    expect(parsed.activity).toEqual(enriched.activity);
    expect(parsed.eligibility).toEqual(enriched.eligibility);
  });

  it('rejects unknown persisted activity facts', () => {
    expect(() => EpisodeV1Schema.parse({
      ...valid,
      activity: {
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

// #1811: real on-disk episodes carry literal JSON `null` in the optional
// slots (an older wheel serialized explicit Nones). `.optional()` on a
// strictObject is absent-OK but null-fatal, so every such file failed strict
// parse. `parseEpisodeV1Read` is the read-side tolerance: strip the known
// null slots, then delegate to the unchanged strict schema.
describe('parseEpisodeV1Read', () => {
  /** The real broken shape from ~/.jinn-client/harness-layer/episodes/. */
  function makeNullBearingEpisode(): Record<string, unknown> {
    const base = makeSampleEpisode({ episodeId: 'ep-null-1' }) as Record<string, unknown>;
    return {
      ...base,
      outcome: { ...(base.outcome as object), summary: null },
      cost: { ...(base.cost as object), tokens: null, usdEstimate: null },
      lineage: null,
    };
  }

  it('strict EpisodeV1Schema rejects the null-bearing on-disk shape', () => {
    expect(() => EpisodeV1Schema.parse(makeNullBearingEpisode())).toThrow();
  });

  it('accepts the null-bearing shape, treating null optionals as absent', () => {
    const parsed = parseEpisodeV1Read(makeNullBearingEpisode());
    expect(parsed.outcome.summary).toBeUndefined();
    expect(parsed.cost.tokens).toBeUndefined();
    expect(parsed.cost.usdEstimate).toBeUndefined();
    expect(parsed.lineage).toBeUndefined();
    // The normalized result round-trips the unchanged strict schema.
    expect(() => EpisodeV1Schema.parse(parsed)).not.toThrow();
  });

  it('strips a null lineage.mintRef inside a present lineage object', () => {
    const episode = {
      ...makeSampleEpisode({ episodeId: 'ep-null-2' }),
      lineage: { episodeId: 'ep-0', mintRef: null },
    };
    const parsed = parseEpisodeV1Read(episode);
    expect(parsed.lineage).toEqual({ episodeId: 'ep-0' });
  });

  it('strips null activity and eligibility', () => {
    const episode = {
      ...makeSampleEpisode({ episodeId: 'ep-null-3' }),
      activity: null,
      eligibility: null,
    };
    const parsed = parseEpisodeV1Read(episode);
    expect(parsed.activity).toBeUndefined();
    expect(parsed.eligibility).toBeUndefined();
  });

  it('still throws on a missing required field', () => {
    const { retention: _retention, ...missingRequired } = makeNullBearingEpisode();
    expect(() => parseEpisodeV1Read(missingRequired)).toThrow();
  });

  it('still throws on an unknown top-level field', () => {
    expect(() => parseEpisodeV1Read({ ...makeNullBearingEpisode(), extra: true })).toThrow();
  });
});
