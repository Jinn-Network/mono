import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeEvidencePortContract } from '@jinn-network/plugin/testing';
import { EPISODE_SCHEMA_VERSION, EpisodeV1Schema, type EpisodeV1 } from '@jinn-network/plugin';
import type { CapturedTask } from '../../src/capture.js';
import { createEvidenceAdapter } from '../../src/adapters/evidence-adapter.js';

/** A sample EpisodeV1 the byte-exact round-trip is checked against. */
function makeSampleEpisode(overrides: Partial<EpisodeV1> = {}): EpisodeV1 {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: 'episode-fixture-1',
    session: { sessionId: 'sess-fixture-1', capturedAt: '2026-07-14T00:00:00.000Z' },
    task: { summary: 'Fix a failing test', distributionTags: ['coding'] },
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
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
    cost: { durationMs: 1000 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
    ...overrides,
  };
}

/** A valid legacy CapturedTask (the pre-EpisodeV1 on-disk shape). */
function makeLegacyCapturedTask(overrides: Partial<CapturedTask> = {}): CapturedTask {
  return {
    session: { sessionId: 'legacy-sess-1', capturedAt: '2026-07-13T00:00:00.000Z' },
    task: { summary: 'A legacy captured task', distributionTags: ['coding', 'python'] },
    environment: {
      harness: { name: 'claude-code', version: '2.0.0' },
      model: 'claude-haiku',
      tools: ['bash', 'read'],
    },
    steps: [
      {
        spanId: 'legacy-turn-1',
        parentSpanId: null,
        name: 'jinn.transcript.user-message',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '1500000000',
        attributes: { 'jinn.capture.event.kind': 'user-message', 'message.content': 'do the thing' },
        redactedKeys: [],
      },
      {
        spanId: 'legacy-tool-1',
        parentSpanId: null,
        name: 'bash',
        startTimeUnixNano: '2000000000',
        endTimeUnixNano: '2500000000',
        attributes: { command: 'ls' },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    cost: { durationMs: 4200 },
    provenance: 'contributed',
    ...overrides,
  };
}

function makeAdapter() {
  const capturesDir = mkdtempSync(join(tmpdir(), 'ev-'));
  return createEvidenceAdapter({ capturesDir });
}

describeEvidencePortContract(makeAdapter, makeSampleEpisode());

describe('EvidenceAdapter — AC2 legacy read', () => {
  it('up-maps a legacy CapturedTask to a valid EpisodeV1 in list()', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-legacy-'));
    const legacy = makeLegacyCapturedTask();
    writeFileSync(join(capturesDir, 'legacy-1.json'), JSON.stringify(legacy));

    const adapter = createEvidenceAdapter({ capturesDir });
    const result = await adapter.list();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const episode = result.value.find((e) => e.episodeId === legacy.session.sessionId);
    expect(episode).toBeDefined();
    if (!episode) return;
    // Fail-closed: the up-map must parse under the strict schema.
    expect(() => EpisodeV1Schema.parse(episode)).not.toThrow();
    expect(episode.schemaVersion).toBe(EPISODE_SCHEMA_VERSION);
    expect(episode.episodeId).toBe('legacy-sess-1');
    expect(episode.environment.skillsLoadout).toEqual([]);
    expect(episode.retention.policy).toBe('local-private');
    expect(episode.task.distributionTags).toEqual(['coding', 'python']);
    // Each step carries a valid discriminated `kind`.
    expect(episode.trajectory.map((s) => s.kind)).toEqual(['jinn.agent_turn', 'jinn.tool_call']);
  });
});

describe('EvidenceAdapter — AC2 byte-exact round-trip', () => {
  it('put(episode) then get(id) deep-equals the put episode', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-rt-'));
    const adapter = createEvidenceAdapter({ capturesDir });
    const episode = makeSampleEpisode({ episodeId: 'rt-1' });
    const putResult = await adapter.put(episode);
    expect(putResult).toEqual({ status: 'ok', value: { episodeId: 'rt-1' } });
    const getResult = await adapter.get('rt-1');
    expect(getResult).toEqual({ status: 'ok', value: episode });
  });

  it('written EpisodeV1 files do not collide with legacy .json captures', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-mix-'));
    // A legacy capture AND a put episode share the dir; neither corrupts the other.
    writeFileSync(join(capturesDir, 'legacy-2.json'), JSON.stringify(makeLegacyCapturedTask()));
    const adapter = createEvidenceAdapter({ capturesDir });
    await adapter.put(makeSampleEpisode({ episodeId: 'ep-mix-1' }));
    expect(existsSync(join(capturesDir, 'ep-mix-1.episode.json'))).toBe(true);

    const list = await adapter.list();
    expect(list.status).toBe('ok');
    if (list.status !== 'ok') return;
    const ids = list.value.map((e) => e.episodeId).sort();
    expect(ids).toEqual(['ep-mix-1', 'legacy-sess-1']);
  });

  it('get() on an unknown id returns ok(null)', async () => {
    const adapter = makeAdapter();
    const result = await adapter.get('never-put');
    expect(result).toEqual({ status: 'ok', value: null });
  });

  it('rejects a traversal episodeId without escaping capturesDir (#1660)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ev-trav-'));
    const capturesDir = join(parent, 'captures');
    const adapter = createEvidenceAdapter({ capturesDir });

    // A sentinel just outside capturesDir a traversal write would clobber.
    const escapeTarget = join(parent, 'evil.episode.json');

    const putResult = await adapter.put(makeSampleEpisode({ episodeId: '../evil' }));
    expect(putResult.status).not.toBe('ok');
    expect(existsSync(escapeTarget)).toBe(false);

    const getResult = await adapter.get('../../etc/whatever');
    // Either a non-ok PortResult, or ok(null) — but never a read outside the dir.
    if (getResult.status === 'ok') expect(getResult.value).toBeNull();
    else expect(getResult.status).not.toBe('ok');
    expect(existsSync(join(parent, 'etc'))).toBe(false);
  });
});
