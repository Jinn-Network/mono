import type { EpisodeV1 } from '../../src/schemas/episode.js';
import { EPISODE_SCHEMA_VERSION } from '../../src/schemas/episode.js';

export function makeSampleEpisode(overrides: Partial<EpisodeV1> = {}): EpisodeV1 {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: 'episode-fixture-1',
    session: { sessionId: 'sess-fixture-1', capturedAt: '2026-07-14T00:00:00.000Z' },
    task: { summary: 'Fix a failing test', distributionTags: [] },
    turns: [
      { role: 'user', content: 'help', timestamp: '2026-07-14T00:00:01.000Z' },
      { role: 'assistant', content: 'sure', timestamp: '2026-07-14T00:00:02.000Z' },
    ],
    toolCalls: [],
    environment: {
      harness: { name: 'hermes', version: '0.1.0' },
      model: 'claude-test',
      tools: ['bash'],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
    cost: { durationMs: 1000 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
    ...overrides,
  };
}
