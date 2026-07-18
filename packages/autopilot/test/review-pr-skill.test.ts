import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const skill = readFileSync(
  join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md'),
  'utf8',
);

describe('review-pr verdict metadata', () => {
  it('uses repo-scoped REST label operations instead of gh pr edit', () => {
    expect(skill).toContain(
      'repos/Jinn-Network/mono/issues/<N>/labels',
    );
    expect(skill).toContain(
      'repos/Jinn-Network/mono/issues/<N>/labels/review%3Aapproved',
    );
    expect(skill).toContain(
      'repos/Jinn-Network/mono/issues/<N>/labels/review%3Achanges-requested',
    );
    expect(skill).not.toContain('gh pr edit <N>');
  });
});
