import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const skill = readFileSync(
  join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md'),
  'utf8',
);

describe('review-pr v2 authority contract', () => {
  it('consumes an exact-head claim and selected reviewer identity', () => {
    expect(skill).toContain('JINN_AUTOPILOT_SESSION_MANIFEST');
    expect(skill).toContain('already won the exact-head review claim');
    expect(skill).toMatch(
      /reviewer\s+identity that is distinct from the PR author/,
    );
    expect(skill).not.toContain('JINN_REVIEW_GH_TOKEN');
    expect(skill).not.toContain('JINN_REVIEW_HEAD_REF');
  });

  it('uses the v2 session protocol for all publication and lifecycle changes', () => {
    expect(skill).toContain('autopilot session review-fix-publish');
    expect(skill).toContain(
      'autopilot session review-verdict --state APPROVE --body-file',
    );
    expect(skill).toContain(
      'autopilot session review-verdict --state REQUEST_CHANGES --body-file',
    );
    expect(skill).toContain('autopilot session human --reason-file');

    const prohibited = [
      'gh pr review',
      'gh pr ready',
      'gh project item-edit',
      'gh pr comment',
      'gh api',
      'git push',
      'git worktree',
      'credential.helper',
    ];
    for (const marker of prohibited) expect(skill).not.toContain(marker);
  });

  it('leaves draft/ready ordering, refs, credentials, and cleanup to v2', () => {
    expect(skill).toMatch(
      /draft\/ready ordering, review refs, credentials, and cleanup remain\s+v2-owned/,
    );
    expect(skill).toContain('Do not redraft or ready the PR yourself');
  });

  it('propagates review authority limits to reviewer and fixer children', () => {
    expect(skill).toMatch(
      /Every delegated-root prompt[\s\S]*worktree must remain detached/,
    );
    expect(skill).toMatch(
      /Every delegated-root prompt[\s\S]*`autopilot session` operations are prohibited/,
    );
    expect(skill).toMatch(
      /A fixer may create tested local commits only/,
    );
    expect(skill).toContain('synchronous-parallel-root mechanism');
  });

  it('keeps verdict and Human payloads outside the detached worktree', () => {
    expect(skill).toContain('SESSION_REPORT_DIR');
    expect(skill).toContain('dirname -- "$JINN_AUTOPILOT_SESSION_MANIFEST"');
    expect(skill).toContain('"$SESSION_REPORT_DIR/review-verdict.md"');
    expect(skill).toContain('"$SESSION_REPORT_DIR/human-reason.md"');
    expect(skill).toMatch(/reports directory[\s\S]*outside the supplied worktree/);
  });
});

describe('review-pr method contract', () => {
  it('keeps one review/fix/re-review coordinator session', () => {
    expect(skill).toContain('same coordinator session');
    expect(skill).toContain('review → fix → re-review');
    expect(skill).toContain('There is no round-count budget');
  });

  it('keeps reviewer/fixer independence', () => {
    expect(skill).toContain(
      'reviewer and fixer must be different fresh contexts',
    );
    expect(skill).toMatch(
      /Re-review uses a\s+fresh reviewer context after every published fix/,
    );
  });

  it('does not approve a human-codeowner surface', () => {
    expect(skill).toContain('human-codeowner');
    expect(skill).toContain('autopilot session human --reason-file');
  });
});
