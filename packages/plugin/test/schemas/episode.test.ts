import { describe, expect, it } from 'vitest';
import { EpisodeV1Schema } from '../../src/schemas/episode.js';
import { makeSampleEpisode } from '../_fixtures/episode.js';

const valid = makeSampleEpisode({ episodeId: 'ep-1' });

describe('EpisodeV1Schema', () => {
  it('parses a valid episode', () => {
    const parsed = EpisodeV1Schema.parse(valid);
    expect(parsed.episodeId).toBe('ep-1');
    expect(parsed.turns).toHaveLength(2);
  });

  it('rejects an episode with an unknown top-level field (strict)', () => {
    expect(() => EpisodeV1Schema.parse({ ...valid, extra: true })).toThrow();
  });

  it('rejects an episode with zero turns', () => {
    expect(() => EpisodeV1Schema.parse({ ...valid, turns: [] })).toThrow();
  });

  it('allows an empty toolCalls array', () => {
    expect(() => EpisodeV1Schema.parse({ ...valid, toolCalls: [] })).not.toThrow();
  });

  it('accepts an optional lineage block', () => {
    const withLineage = { ...valid, lineage: { episodeId: 'ep-0', mintRef: 'mint-1' } };
    expect(EpisodeV1Schema.parse(withLineage).lineage?.mintRef).toBe('mint-1');
  });
});
