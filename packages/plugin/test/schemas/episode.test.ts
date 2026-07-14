import { describe, expect, it } from 'vitest';
import { EpisodeV1Schema } from '../../src/schemas/episode.js';
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
});
