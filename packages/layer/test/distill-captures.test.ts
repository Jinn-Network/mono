import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapturedTask } from '../src/capture.js';
import { buildSkillMarkdown, type SkillPackage } from '../src/skill-package.js';
import {
  coveredSessionIds,
  episodeToCapturedTask,
  localSkillProvenance,
  loadRecentCaptures,
  loadRecentDistillSources,
  provenanceLabels,
  stagingDirFor,
} from '../src/distill-captures.js';
import type { EpisodeV1 } from '@jinn-network/plugin';

function capture(sessionId: string, capturedAt: string, summary = sessionId): CapturedTask {
  return {
    session: { sessionId, capturedAt },
    task: { summary, distributionTags: ['coding'] },
    environment: { harness: { name: 'codex', version: '1.0.0' }, model: 'gpt-5.5', tools: ['shell'] },
    steps: [
      {
        spanId: `${sessionId}-span`,
        parentSpanId: null,
        name: 'jinn.transcript.user-message',
        startTimeUnixNano: '1752000000000000000',
        endTimeUnixNano: '1752000001000000000',
        attributes: { 'message.content': summary },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted', summary },
    cost: { durationMs: 1000 },
    provenance: 'contributed',
  };
}

function writeCapture(dir: string, name: string, task: CapturedTask): void {
  writeFileSync(join(dir, name), JSON.stringify(task, null, 2));
}

function episode(
  episodeId: string,
  sessionId: string,
  capturedAt: string,
  summary = sessionId,
): EpisodeV1 {
  return {
    schemaVersion: 'jinn.episode.v1',
    episodeId,
    retrievalVisible: false,
    session: { sessionId, capturedAt, kind: 'user' },
    origin: { writer: 'hermes-agent', build: '1.0.0' },
    task: { summary, distributionTags: [] },
    trajectory: [{
      spanId: `${episodeId}-span`,
      parentSpanId: null,
      kind: 'jinn.tool_call',
      name: 'tool:terminal',
      startTimeUnixNano: '1752000000000000000',
      endTimeUnixNano: '1752000001000000000',
      attributes: { 'tool.args': { command: 'yarn test' } },
      redactedKeys: [],
      events: [{ timeUnixNano: '1752000000500000000', name: 'stdout' }],
      status: { code: 'OK' },
    }],
    environment: {
      harness: { name: 'hermes-agent', version: '1.0.0' },
      model: 'test-model',
      tools: ['terminal'],
      skillsLoadout: ['systematic-debugging'],
    },
    outcome: { status: 'completed', verificationStrength: 'tests-passed' },
    cost: { durationMs: 1000 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
  };
}

function skill(name: string, provenance: string[]): SkillPackage {
  return {
    name,
    description: `Use ${name}. Not for: unrelated work.`,
    license: null,
    jinn: {
      schema: 'jinn.skill.v1',
      distribution: 'coding',
      verifiabilityTier: 'user-accepted',
      distilledFrom: provenance.length > 0 ? 1 : 0,
      provenance,
      distilledAt: '2026-07-09T00:00:00.000Z',
      skillKind: 'strategic-pattern',
    },
    body: [
      '## When to use',
      'Use it.',
      '## Strategy',
      'Do the thing.',
      '## Steps',
      '1. Run it.',
      '## Pitfalls',
      'Avoid overuse.',
      '## Verify',
      'Check output.',
    ].join('\n\n'),
  };
}

describe('distill capture source helpers', () => {
  it('projects a canonical episode into the existing local-distiller input without losing trace facts', () => {
    const projected = episodeToCapturedTask(episode(
      'episode-1',
      'session-1',
      '2026-07-09T00:00:00.000Z',
      'canonical work',
    ));

    expect(projected).toMatchObject({
      session: { sessionId: 'session-1' },
      task: { summary: 'canonical work', distributionTags: ['hermes-agent'] },
      environment: { skillsLoadout: ['systematic-debugging'] },
      outcome: { verifiabilityTier: 'tests-passed' },
    });
    expect(projected.steps[0]).toMatchObject({
      kind: 'jinn.tool_call',
      events: [{ name: 'stdout' }],
      status: { code: 'OK' },
    });
  });

  it('loads episodes first, keeps legacy reads, dedupes by session with canonical precedence, then limits globally', async () => {
    const episodesDir = mkdtempSync(join(tmpdir(), 'distill-episodes-'));
    const legacyCapturesDir = mkdtempSync(join(tmpdir(), 'distill-legacy-captures-'));
    writeFileSync(
      join(episodesDir, 'canonical.episode.json'),
      JSON.stringify(episode('ep-shared', 'shared', '2026-07-10T00:00:00.000Z', 'canonical wins')),
    );
    writeFileSync(
      join(episodesDir, 'newest.episode.json'),
      JSON.stringify(episode('ep-newest', 'newest', '2026-07-12T00:00:00.000Z')),
    );
    writeCapture(
      legacyCapturesDir,
      'duplicate.json',
      capture('shared', '2026-07-11T00:00:00.000Z', 'legacy duplicate'),
    );
    writeCapture(
      legacyCapturesDir,
      'middle.json',
      capture('middle', '2026-07-11T12:00:00.000Z'),
    );

    const loaded = await loadRecentDistillSources({
      episodesDir,
      legacyCapturesDir,
      limit: 3,
    });

    expect(loaded.map((row) => [row.session.sessionId, row.task.summary])).toEqual([
      ['newest', 'newest'],
      ['middle', 'middle'],
      ['shared', 'canonical wins'],
    ]);
  });

  it('loads newest captures first, applies the limit, and skips malformed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'distill-captures-'));
    writeCapture(dir, 'old.json', capture('old', '2026-07-08T00:00:00.000Z', 'old work'));
    writeCapture(dir, 'new.json', capture('new', '2026-07-09T00:00:00.000Z', 'new work'));
    writeFileSync(join(dir, 'broken.json'), '{ not json');

    const loaded = loadRecentCaptures(dir, 1);

    expect(loaded.map((c) => c.session.sessionId)).toEqual(['new']);
  });

  it('returns an empty list for a missing captures directory', () => {
    const dir = join(tmpdir(), `missing-distill-captures-${Date.now()}`);
    expect(loadRecentCaptures(dir, 50)).toEqual([]);
  });

  it('derives the staging directory beside the active skill directory', () => {
    expect(stagingDirFor('/tmp/skills/')).toBe('/tmp/skills-staged');
  });

  it('finds session ids already covered by installed or staged skills', () => {
    const active = mkdtempSync(join(tmpdir(), 'distill-active-'));
    const staged = mkdtempSync(join(tmpdir(), 'distill-staged-'));
    mkdirSync(join(active, 'one'), { recursive: true });
    mkdirSync(join(staged, 'two'), { recursive: true });
    writeFileSync(join(active, 'one', 'SKILL.md'), buildSkillMarkdown(skill('one', ['local-capture:s1'])));
    writeFileSync(join(staged, 'two', 'SKILL.md'), buildSkillMarkdown(skill('two', ['local-capture:s2'])));

    expect([...coveredSessionIds([active, staged])].sort()).toEqual(['s1', 's2']);
  });

  it('maps local-capture provenance refs to summaries when available', () => {
    const labels = provenanceLabels(
      { jinn: { provenance: ['local-capture:s1', 'bafyOther'] } },
      new Map([['s1', 'Fix flaky distill test']]),
    );

    expect(labels).toEqual(['Fix flaky distill test', 'bafyOther']);
  });

  it('derives installed and staged skill state from SKILL.md provenance', () => {
    const active = mkdtempSync(join(tmpdir(), 'history-active-'));
    const staged = mkdtempSync(join(tmpdir(), 'history-staged-'));
    mkdirSync(join(active, 'installed-skill'), { recursive: true });
    mkdirSync(join(staged, 'staged-skill'), { recursive: true });
    writeFileSync(
      join(active, 'installed-skill', 'SKILL.md'),
      buildSkillMarkdown(skill('installed-skill', ['local-capture:s1', 'bafy-public'])),
    );
    writeFileSync(
      join(staged, 'staged-skill', 'SKILL.md'),
      buildSkillMarkdown(skill('staged-skill', ['local-capture:s1', 'local-capture:s2'])),
    );

    expect(localSkillProvenance(active, staged)).toEqual([
      {
        ref: 'local-skill:installed-skill',
        sourceSessionIds: ['s1'],
        state: 'installed',
      },
      {
        ref: 'local-skill:staged-skill',
        sourceSessionIds: ['s1', 's2'],
        state: 'staged',
      },
    ]);
  });
});
