/**
 * EpisodeV1 dual-write compat fence (mono #1662).
 *
 * The plugin now dual-writes: the legacy `CapturedTask` stays in the captures
 * dir the distiller reads, while the complete-trajectory `EpisodeV1` goes to a
 * SEPARATE dir. Two guarantees this test pins:
 *
 *   1. A legacy capture in the byte shape the plugin's `assemble()` emits still
 *      parses via `loadRecentCaptures` → `parseCapturedTask`.
 *   2. If an `EpisodeV1` file ever lands in the captures dir, the reader SKIPS
 *      it with a warning (strict-parse mismatch) — it never crashes the loop.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecentCaptures } from '../src/distill-captures.js';

// Inlined (not imported from packages/plugin) to avoid pulling that package's
// own zod resolution into this suite; the literal is the schema of record in
// packages/plugin/src/schemas/episode.ts (EPISODE_SCHEMA_VERSION).
const EPISODE_SCHEMA_VERSION = 'jinn.episode.v1';

/** The exact byte shape the plugin's capture_buffer.assemble() writes today. */
const LEGACY_CAPTURE = {
  session: { sessionId: 's1', capturedAt: '2026-07-15T00:00:00.000Z' },
  task: { summary: 'Fix the failing retry test', distributionTags: ['hermes-agent', 'cli'] },
  environment: {
    harness: { name: 'hermes-agent', version: '1.0.0' },
    model: 'test-model',
    tools: ['terminal'],
  },
  steps: [
    {
      spanId: 'c1',
      parentSpanId: null,
      name: 'tool:terminal',
      startTimeUnixNano: '1752000000000000000',
      endTimeUnixNano: '1752000001000000000',
      attributes: { 'tool.args': { command: 'yarn test' }, 'tool.result': '1 failed' },
      redactedKeys: [],
    },
  ],
  outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
  cost: { durationMs: 1000 },
  provenance: 'contributed',
};

/** The EpisodeV1 shape the plugin dual-writes to its OWN dir. */
const EPISODE_V1 = {
  schemaVersion: EPISODE_SCHEMA_VERSION,
  episodeId: 's1-1752000000000000000',
  session: { sessionId: 's1', capturedAt: '2026-07-15T00:00:00.000Z' },
  task: { summary: 'Fix the failing retry test', distributionTags: [] },
  trajectory: [
    {
      spanId: 'turn-1',
      parentSpanId: null,
      kind: 'jinn.agent_turn',
      name: 'turn:user',
      startTimeUnixNano: '1752000000000000000',
      endTimeUnixNano: '1752000000000000000',
      attributes: { 'turn.text': 'Fix the failing retry test', role: 'user' },
      redactedKeys: [],
    },
  ],
  environment: {
    harness: { name: 'hermes-agent', version: '1.0.0' },
    model: 'test-model',
    tools: ['terminal'],
    skillsLoadout: ['tdd'],
  },
  outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
  cost: { durationMs: 1000, tokens: { input: 100, output: 50 } },
  retention: { policy: 'local-private' },
  provenance: 'contributed',
};

describe('EpisodeV1 dual-write compat fence', () => {
  it('still parses a legacy capture in the plugin assemble() byte shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'distill-compat-legacy-'));
    writeFileSync(join(dir, 's1.json'), JSON.stringify(LEGACY_CAPTURE, null, 2));

    const loaded = loadRecentCaptures(dir, 50);

    expect(loaded.map((c) => c.session.sessionId)).toEqual(['s1']);
    expect(loaded[0].steps[0].name).toBe('tool:terminal');
  });

  it('skips an EpisodeV1 file dropped into the captures dir without crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'distill-compat-episode-'));
    writeFileSync(join(dir, 's1.json'), JSON.stringify(LEGACY_CAPTURE, null, 2));
    writeFileSync(join(dir, 'episode.json'), JSON.stringify(EPISODE_V1, null, 2));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = loadRecentCaptures(dir, 50);

    // Only the legacy capture is read; the episode is skipped with a warning.
    expect(loaded.map((c) => c.session.sessionId)).toEqual(['s1']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping malformed capture file episode.json'));
    warn.mockRestore();
  });
});
