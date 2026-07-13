import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapturedTask } from '../src/capture.js';
import { buildSkillMarkdown, type SkillPackage } from '../src/skill-package.js';
import {
  coveredSessionIds,
  loadRecentCaptures,
  provenanceLabels,
  stagingDirFor,
} from '../src/distill-captures.js';

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
});
