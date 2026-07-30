import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildSkillFrontmatter, lintFrontmatter, buildJinnReceiptMetadata,
} from '../../src/skills-bench/frontmatter.js';

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

describe('buildSkillFrontmatter — YAML quoting (final-review.md I5)', () => {
  it('quotes a description containing the "Use when: ..." idiom and round-trips with zero lint problems', () => {
    const description = 'Test-driven development workflow. Use when: fixing bugs or implementing features.';
    const fm = buildSkillFrontmatter({ name: 'tdd', description, metadata: {} });
    expect(fm).toContain(`description: "${description}"`);
    expect(lintFrontmatter(fm)).toEqual([]);
  });

  it('quotes a metadata URL value (colon-slash-slash) and round-trips with zero lint problems', () => {
    const receiptUrl = 'https://github.com/Jinn-Network/skills/blob/main/receipts/tdd.md';
    const fm = buildSkillFrontmatter({
      name: 'tdd',
      description: 'd',
      metadata: { 'jinn.receipt': receiptUrl },
    });
    expect(fm).toContain(`  jinn.receipt: "${receiptUrl}"`);
    expect(lintFrontmatter(fm)).toEqual([]);
  });
});

describe('buildJinnReceiptMetadata (final-review.md I6)', () => {
  it('hashes the receipt file and returns exactly the four jinn.* keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'receipt-'));
    const receiptFilePath = join(dir, 'tdd.md');
    const receiptContents = '```\nskill: tdd\n```\n';
    await writeFile(receiptFilePath, receiptContents);
    const expectedSha256 = createHash('sha256').update(receiptContents).digest('hex');

    const metadata = await buildJinnReceiptMetadata({
      receiptUrl: 'https://github.com/Jinn-Network/skills/blob/main/receipts/tdd.md',
      receiptFilePath,
      measuredOn: '2026-08-01',
      forkedFrom: 'mattpocock/skills@abc123',
    });

    expect(Object.keys(metadata).sort()).toEqual(
      ['jinn.forked-from', 'jinn.measured-on', 'jinn.receipt', 'jinn.receipt-sha256'].sort(),
    );
    expect(metadata['jinn.receipt']).toBe('https://github.com/Jinn-Network/skills/blob/main/receipts/tdd.md');
    expect(metadata['jinn.receipt-sha256']).toBe(expectedSha256);
    expect(metadata['jinn.receipt-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata['jinn.measured-on']).toBe('2026-08-01');
    expect(metadata['jinn.forked-from']).toBe('mattpocock/skills@abc123');
  });

  it('omits jinn.forked-from when not given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'receipt-'));
    const receiptFilePath = join(dir, 'wave1.md');
    await writeFile(receiptFilePath, 'contents');

    const metadata = await buildJinnReceiptMetadata({
      receiptUrl: 'https://github.com/Jinn-Network/skills/blob/main/receipts/wave1.md',
      receiptFilePath,
      measuredOn: '2026-08-01',
    });

    expect(Object.keys(metadata).sort()).toEqual(
      ['jinn.measured-on', 'jinn.receipt', 'jinn.receipt-sha256'].sort(),
    );
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
