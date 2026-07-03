/**
 * openredaction tuning — regression net for issue #1331.
 *
 * Empirical finding: three of openredaction's shipped patterns are bare-word
 * matchers (`INSTAGRAM_USERNAME` = `\b[a-zA-Z0-9._]{3,30}\b`, plus
 * `XBOX_GAMERTAG` and `PSN_ID` with the same shape). Under the default
 * detector they fire on nearly EVERY word of ordinary technical prose —
 * "Update the staging bucket config" becomes `[IG_USER_…] the staging
 * [IG_USER_…] [IG_USER_…]` — destroying the readability (and distillation
 * value) of every published trajectory.
 *
 * The fix denylists the audited bare-word patterns at stage-factory time.
 * These tests pin both directions: prose must survive, and genuine PII
 * coverage must not weaken (the seeded-secrets fixture in
 * packages/harness-layer is the second net).
 */

import { describe, expect, it } from 'vitest';
import { OpenRedaction } from 'openredaction';
import {
  BARE_WORD_PATTERN_DENYLIST,
  PROSE_TRIGGER_PATTERN_DENYLIST,
  buildDefaultDetector,
  openredactionStage,
} from '../../../src/trajectory/scrub/openredaction-stage.js';
import { buildScrubPipeline, DEFAULT_KEY_POLICY } from '../../../src/trajectory/scrub/build.js';

const PROSE = 'Update the staging bucket config in src/app.tsx and rerun the suite.';

describe('openredaction stage tuning (#1331)', () => {
  it('ordinary technical prose passes through unchanged', async () => {
    const stage = openredactionStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({ 'llm.prompt': PROSE });
    expect(result.attributes['llm.prompt']).toBe(PROSE);
    expect(result.redactions).toHaveLength(0);
  });

  it('genuine PII still redacts: email, card, AWS key, SSN', async () => {
    const stage = openredactionStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({
      'llm.prompt':
        'Email jane.doe@corp.com, card 4111 1111 1111 1111, key AKIAIOSFODNN7EXAMPLE, SSN 078-05-1120.',
    });
    const out = String(result.attributes['llm.prompt']);
    expect(out).not.toContain('jane.doe@corp.com');
    expect(out).not.toContain('4111 1111 1111 1111');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('078-05-1120');
    const types = new Set(result.redactions.map((r) => r.detail));
    expect(types).toContain('EMAIL');
    expect(types).toContain('CREDIT_CARD');
    expect(types).toContain('AWS_ACCESS_KEY');
    expect(types).toContain('SSN');
  });

  it('structural audit: no active pattern is a bare-word matcher', () => {
    // The forward-looking net: if an openredaction version bump ships another
    // pattern that matches ordinary words, this fails and the denylist grows.
    const detector = buildDefaultDetector();
    const words = ['update', 'config', 'staging', 'bucket', 'rerun', 'suite'];
    const offenders: string[] = [];
    for (const p of detector.getPatterns()) {
      const hits = words.filter((w) => {
        p.regex.lastIndex = 0;
        return p.regex.test(w);
      });
      if (hits.length >= 2) offenders.push(p.type);
    }
    expect(offenders).toEqual([]);
  });

  it('the denylist names only audited pathological patterns and they exist upstream', () => {
    const upstream = new Set(new OpenRedaction().getPatterns().map((p) => p.type));
    for (const type of BARE_WORD_PATTERN_DENYLIST) {
      expect(upstream.has(type)).toBe(true);
    }
    expect(BARE_WORD_PATTERN_DENYLIST).toContain('INSTAGRAM_USERNAME');
  });

  it('slug segments with lab/test/sample trigger words survive (the LAB_TEST_ID / EXAM_ID FPs, #1348)', async () => {
    // openredaction's LAB_TEST_ID (`\b(?:LAB|TEST|SAMPLE)[-\s]?…\b`) and
    // EXAM_ID (`\b(?:EXAM|TEST|QUIZ|ASSESSMENT)[-\s]?…\b`) patterns, both
    // case-insensitive with a bare `[A-Z0-9]{6,12}` tail, rewrote
    // "test-driven-development" to "test-[LAB_8465]-development". Their
    // trigger words are ubiquitous in software slugs and prose; lab-specimen
    // and exam IDs are not plausible in agent-trajectory content.
    const stage = openredactionStage(DEFAULT_KEY_POLICY);
    const summary =
      'Seed import: obra/superpowers/skills/test-driven-development plus the sample-config fixture.';
    const result = await stage.scrub({ 'task.summary': summary });
    expect(result.attributes['task.summary']).toBe(summary);
    expect(result.redactions).toHaveLength(0);
  });

  it('sentence-initial capitalised phrases survive (the NAME follower-branch FP)', async () => {
    // "Fix the failing test" matched openredaction's NAME pattern (its
    // follower branch accepts lowercase words). Person names are the ML PII
    // stage's job; the regex stage must not eat task summaries.
    const stage = openredactionStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({
      'task.summary': 'Fix the failing test suite after the zod upgrade. The Quick start guide is stale.',
    });
    expect(result.attributes['task.summary']).toBe(
      'Fix the failing test suite after the zod upgrade. The Quick start guide is stale.',
    );
  });
});

/**
 * Skill-body prose defacement — regression net for issue #1372.
 *
 * The 42 published seed skills' SKILL.md bodies came back mangled by
 * trigger-word patterns: an ordinary English trigger (`TO`, `APPROVAL`,
 * `PROJECT`, `ORDER`, `REVIEW`, `PASS`, `LOT`, `SO`, `REG`, `WO`, `MISSING`,
 * `RETURN`, `user`, `prod`…) followed by a bare `[A-Z0-9]{n,m}` tail,
 * case-insensitive — so "project context" → `project [PROJECT_3875]`,
 * "something" → `so[SO_1826]` (mid-word), "workflow" → `wo[WO_3602]`.
 * Every phrase below was observed defaced in a published seed skill.
 */
const SKILL_PROSE = [
  'You MUST use this before any creative work. Learn how to use the skill first.',
  'First get your approval before merging; understand user intent and the project context.',
  'Every project goes through this process, so something like a workflow or worktree helps.',
  'The order should be: fix regressions, review performance problems, then note the variation.',
  'No production classes ship without a failing test; expect a pass immediately or return expected errors.',
  'Missing requirements cause the most wasted work. Practice questions when possible, a lot faster.',
].join('\n');

describe('openredaction stage tuning (#1372): skill-body prose survives', () => {
  it('representative skill prose passes through the stage unchanged', async () => {
    const stage = openredactionStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({ 'skill.body': SKILL_PROSE });
    expect(result.attributes['skill.body']).toBe(SKILL_PROSE);
    expect(result.redactions).toHaveLength(0);
  });

  it('representative skill prose survives the full pipeline verbatim', async () => {
    const pipeline = buildScrubPipeline();
    const result = await pipeline.run({ 'skill.body': SKILL_PROSE });
    expect(result.attributes['skill.body']).toBe(SKILL_PROSE);
  });

  it('the prose-trigger denylist entries all exist upstream', () => {
    const upstream = new Set(new OpenRedaction().getPatterns().map((p) => p.type));
    for (const type of PROSE_TRIGGER_PATTERN_DENYLIST) {
      expect(upstream.has(type), `${type} not in openredaction`).toBe(true);
    }
    expect(PROSE_TRIGGER_PATTERN_DENYLIST).toContain('PROJECT_CODE');
    expect(PROSE_TRIGGER_PATTERN_DENYLIST).toContain('IATA_AIRPORT_CODE');
  });

  it('genuine secret-shaped content still redacts with the wider denylist', async () => {
    const stage = openredactionStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({
      'llm.prompt':
        'Email jane.doe@corp.com, card 4111 1111 1111 1111, key AKIAIOSFODNN7EXAMPLE, SSN 078-05-1120.',
    });
    const out = String(result.attributes['llm.prompt']);
    expect(out).not.toContain('jane.doe@corp.com');
    expect(out).not.toContain('4111 1111 1111 1111');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('078-05-1120');
  });
});
