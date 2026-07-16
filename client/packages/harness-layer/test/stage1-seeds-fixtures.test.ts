/**
 * Stage 1 seed fixture lint (issue #1771).
 *
 * `client/packages/harness-layer/fixtures/stage1-seeds/` is the curated
 * evidence-episode + skill-shaped seed set the rescope plan's R5 acceptance
 * gate (docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md
 * §4.3-§4.4) and the manual testnet seeding runbook
 * (docs/runbooks/stage1-evidence-seeding.md) both read by repo-relative
 * path. This test is the fixture set's own regression net: every file must
 * be schema-valid, scrub-clean (no absolute paths / usernames), and
 * deterministically formatted (a hand-edit or re-generation must not
 * silently introduce noise).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SeedEpisodeSchema } from '../src/seed-import/episode-fetch.js';
import { SeedSkillSchema } from '../src/seed-import/fetch.js';
import { hashSeedContent } from '../src/seed-import/state.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/stage1-seeds', import.meta.url));

const EPISODE_FILES = [
  'distractor-operator-claims.episode.json',
  'distractor-sympy-printing.episode.json',
  'source-dashboard-flake.episode.json',
];
const SKILL_FILES = ['distractor-skill-tdd-dup.json', 'distractor-skill-tdd.json'];
const EXPECTED_FILES = [...EPISODE_FILES, ...SKILL_FILES].sort();

/**
 * Patterns a scrubbed, repo-relative fixture must never contain. Checked
 * against DECODED string values (post JSON.parse), not raw file bytes — the
 * raw JSON text's `\n`/`\t` escape sequences are single-backslash-plus-letter
 * and would otherwise false-positive against a naive "letter:\" pattern.
 */
const ABSOLUTE_PATH_PATTERNS: Array<[string, RegExp]> = [
  ['macOS/Linux /Users/ path', /\/Users\/[^/\s"]+/],
  ['Linux /home/ path', /\/home\/[^/\s"]+/],
  ['Windows drive path', /[A-Za-z]:\\[^\\\s"]+/],
  ['home-dir tilde path', /~\/[^\s"]+/],
];

function rawText(file: string): string {
  return readFileSync(join(FIXTURES_DIR, file), 'utf-8');
}

function parseJson(file: string): unknown {
  return JSON.parse(rawText(file));
}

/** Recursively collect every string value in a parsed JSON structure. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) allStrings(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) allStrings(v, out);
  }
  return out;
}

describe('stage1-seeds fixture set (issue #1771)', () => {
  it('contains exactly the expected files', () => {
    const actual = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(actual).toEqual(EXPECTED_FILES);
  });

  describe.each(EPISODE_FILES)('%s', (file) => {
    it('is schema-valid against SeedEpisodeSchema', () => {
      expect(() => SeedEpisodeSchema.parse(parseJson(file))).not.toThrow();
    });

    it('contains no absolute path, home-dir tilde, or Windows drive path', () => {
      for (const s of allStrings(parseJson(file))) {
        for (const [label, pattern] of ABSOLUTE_PATH_PATTERNS) {
          expect(pattern.test(s), `${file}: matched ${label} in ${JSON.stringify(s.slice(0, 80))}`).toBe(false);
        }
      }
    });

    it('contains no reference to this machine\'s username or home directory', () => {
      const identifiers = [process.env['USER'], process.env['LOGNAME'], homedir()].filter(
        (v): v is string => Boolean(v) && v.length >= 3,
      );
      for (const s of allStrings(parseJson(file))) {
        for (const id of identifiers) {
          expect(s.includes(id), `${file}: contains "${id}"`).toBe(false);
        }
      }
    });

    it('is deterministically formatted (stable JSON.stringify(_, null, 2) round-trip)', () => {
      const raw = rawText(file);
      const parsed = JSON.parse(raw);
      expect(JSON.stringify(parsed, null, 2) + '\n').toBe(raw);
    });

    it('the idempotency content hash is a pure function of the fixture', () => {
      const parsed = parseJson(file);
      expect(hashSeedContent(parsed)).toBe(hashSeedContent(parsed));
    });
  });

  describe.each(SKILL_FILES)('%s', (file) => {
    it('is schema-valid against SeedSkillSchema', () => {
      expect(() => SeedSkillSchema.parse(parseJson(file))).not.toThrow();
    });

    it('contains no absolute path, home-dir tilde, or Windows drive path', () => {
      for (const s of allStrings(parseJson(file))) {
        for (const [label, pattern] of ABSOLUTE_PATH_PATTERNS) {
          expect(pattern.test(s), `${file}: matched ${label} in ${JSON.stringify(s.slice(0, 80))}`).toBe(false);
        }
      }
    });

    it('is deterministically formatted (stable JSON.stringify(_, null, 2) round-trip)', () => {
      const raw = rawText(file);
      const parsed = JSON.parse(raw);
      expect(JSON.stringify(parsed, null, 2) + '\n').toBe(raw);
    });
  });

  describe('source episode (source-dashboard-flake.episode.json)', () => {
    const source = () => SeedEpisodeSchema.parse(parseJson('source-dashboard-flake.episode.json'));

    it('has at least one failure step and its fix (issue #1771 AC)', () => {
      const labels = source().steps.map((s) => s.label);
      expect(labels).toContain('failure');
      expect(labels).toContain('fix');
    });

    it('re-performs the real 163e070d fix at its pre-fix base commit', () => {
      const ep = source();
      expect(ep.repo).toBe('Jinn-Network/mono');
      expect(ep.baseCommit).toBe('3651de92ccda900dc6d052b94035f9a86d5b21be');
      expect(ep.attribution.sourceUrl).toContain('163e070d254aaa1f8e980d1a69888f8d8baf9f14');
    });

    it('carries the exact tag set named in the issue', () => {
      expect(source().tags).toEqual(['mono', 'dashboard', 'vitest', 'version-status', 'async', 'flake']);
    });

    it('outcome is completed / tests-passed', () => {
      expect(source().outcome).toEqual({ status: 'completed', verifiabilityTier: 'tests-passed' });
    });

    it('the synthesis is 3-6 sentences', () => {
      const sentenceCount = source().synthesis.split(/(?<=[.!?])\s+/).filter(Boolean).length;
      expect(sentenceCount).toBeGreaterThanOrEqual(3);
      expect(sentenceCount).toBeLessThanOrEqual(6);
    });

    it('the diff excerpt matches the real 163e070d diff', () => {
      const diffStep = source().steps.find((s) => s.label === 'diff')!;
      expect(diffStep.text).toContain("await waitFor(() => expect(apiMocks.getStatus).toHaveBeenCalled());");
      expect(diffStep.text).toContain("await waitFor(() => expect(result.current.map(n => n.kind)).toContain('funding_low'));");
    });
  });

  describe('skill-shaped distractors (D3/D4) — same content, distinct identity', () => {
    it('distractor-skill-tdd-dup.json duplicates distractor-skill-tdd.json content exactly', () => {
      const d3 = SeedSkillSchema.parse(parseJson('distractor-skill-tdd.json'));
      const d4 = SeedSkillSchema.parse(parseJson('distractor-skill-tdd-dup.json'));
      expect(d4.skillMd).toBe(d3.skillMd);
      expect(d4.description).toBe(d3.description);
      expect(d4.skill).not.toBe(d3.skill); // distinct identity, same content — proves consumer-side dedup is content-keyed
    });
  });

  describe('distractors are distinguishable from the source (selection can tell them apart)', () => {
    it('D1 shares the repo but not the module/vocabulary with the source', () => {
      const d1 = SeedEpisodeSchema.parse(parseJson('distractor-operator-claims.episode.json'));
      const source = SeedEpisodeSchema.parse(parseJson('source-dashboard-flake.episode.json'));
      expect(d1.repo).toBe(source.repo);
      expect(d1.tags).not.toEqual(expect.arrayContaining(['dashboard']));
    });

    it('D2 is a different domain entirely (not the mono repo)', () => {
      const d2 = SeedEpisodeSchema.parse(parseJson('distractor-sympy-printing.episode.json'));
      expect(d2.repo).not.toBe('Jinn-Network/mono');
      expect(d2.tags).not.toEqual(expect.arrayContaining(['mono']));
    });
  });
});
