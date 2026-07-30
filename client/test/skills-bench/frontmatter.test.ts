import { describe, expect, it } from 'vitest';
import { buildSkillFrontmatter, lintFrontmatter } from '../../src/skills-bench/frontmatter.js';

describe('buildSkillFrontmatter', () => {
  it('emits only spec-allowed keys with flat string metadata', () => {
    const fm = buildSkillFrontmatter({
      name: 'tdd',
      description: 'Test-driven development workflow. Use when implementing features or fixing bugs.',
      license: 'MIT',
      metadata: {
        'jinn.receipt': 'https://github.com/Jinn-Network/skills/blob/main/receipts/tdd.md',
        'jinn.receipt-sha256': 'deadbeef',
        'jinn.measured-on': '2026-08-01',
        'jinn.forked-from': 'mattpocock/skills@abc123',
      },
    });
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm).toContain('name: tdd');
    expect(fm).toContain('  jinn.receipt: ');
    expect(lintFrontmatter(fm)).toEqual([]);
  });
});

describe('lintFrontmatter', () => {
  it('rejects spec violations', () => {
    expect(lintFrontmatter('---\nname: TDD\ndescription: d\n---\n')).toContainEqual(
      expect.stringMatching(/name/));                       // uppercase
    expect(lintFrontmatter('---\nname: a--b\ndescription: d\n---\n')).toContainEqual(
      expect.stringMatching(/name/));                       // consecutive hyphens
    expect(lintFrontmatter(`---\nname: ok\ndescription: ${'x'.repeat(1025)}\n---\n`)).toContainEqual(
      expect.stringMatching(/description/));                // >1024 chars
    expect(lintFrontmatter('---\nname: ok\ndescription: d\nbenchmarked: true\n---\n')).toContainEqual(
      expect.stringMatching(/unknown key/));                // unknown top-level key
    expect(lintFrontmatter('---\nname: ok\n---\n')).toContainEqual(
      expect.stringMatching(/description/));                // missing description
  });
});
