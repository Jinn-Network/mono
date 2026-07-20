import type { EpisodeV1 } from '../../src/schemas/episode.js';
import { EPISODE_SCHEMA_VERSION } from '../../src/schemas/episode.js';

export function makeSampleEpisode(overrides: Partial<EpisodeV1> = {}): EpisodeV1 {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: 'episode-fixture-1',
    retrievalVisible: false,
    session: {
      sessionId: 'sess-fixture-1',
      capturedAt: '2026-07-14T00:00:00.000Z',
      kind: 'user',
    },
    origin: { writer: 'hermes', build: '0.1.0' },
    task: { summary: 'Fix a failing test', distributionTags: [] },
    trajectory: [
      {
        spanId: 'span-turn-1',
        parentSpanId: null,
        kind: 'jinn.agent_turn',
        name: 'turn',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '1000000000',
        attributes: { role: 'user', content: 'help' },
        redactedKeys: [],
      },
      {
        spanId: 'span-turn-2',
        parentSpanId: null,
        kind: 'jinn.agent_turn',
        name: 'turn',
        startTimeUnixNano: '2000000000',
        endTimeUnixNano: '2000000000',
        attributes: { role: 'assistant', content: 'sure' },
        redactedKeys: [],
      },
      {
        spanId: 'span-tool-1',
        parentSpanId: null,
        kind: 'jinn.tool_call',
        name: 'bash',
        startTimeUnixNano: '3000000000',
        endTimeUnixNano: '4000000000',
        attributes: { args: 'ls', result: 'ok' },
        redactedKeys: [],
      },
    ],
    environment: {
      harness: { name: 'hermes', version: '0.1.0' },
      model: 'claude-test',
      tools: ['bash'],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verificationStrength: 'user-accepted' },
    cost: { durationMs: 1000 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
    ...overrides,
  };
}
