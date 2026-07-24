// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
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
    expect(skill).toContain(
      'autopilot session review-verdict --state APPROVE --body-file',
    );
    expect(skill).toContain('--follow-ups-file');
    expect(skill).toContain('autopilot session review-findings --file');
    expect(skill).toContain('autopilot session human --reason-file');
    expect(skill).not.toContain('autopilot session review-fix-publish');

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
    expect(skill).toContain('Never redraft or ready the PR yourself');
    expect(skill).toContain('Never push to the PR branch');
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
  it('has exactly two terminal outcomes: approve or file findings', () => {
    expect(skill).toContain('Terminal outcomes (exactly two)');
    expect(skill).toContain('### Approve');
    expect(skill).toContain('### Request changes');
    expect(skill).toContain('review-findings.md');
    expect(skill).toContain('review-follow-ups.json');
    expect(skill).toMatch(/merge-blocking/i);
    expect(skill).toMatch(/non-blocking/i);
    expect(skill).not.toContain('jinn-autopilot:child');
    expect(skill).not.toContain('review → fix → re-review');
  });

  it('does not approve a human-codeowner surface', () => {
    expect(skill).toMatch(/CODEOWNER/);
    expect(skill).toContain('autopilot session human --reason-file');
  });
});
