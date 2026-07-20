import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

describe('merge-prep v2 skill contract', () => {
  const skill = read('.claude/skills/merge-prep/SKILL.md');

  it('consumes an attempt and reports through the session protocol', () => {
    expect(skill).toContain('JINN_AUTOPILOT_SESSION_MANIFEST');
    expect(skill).toContain(
      'autopilot session merge-prep-complete --summary-file',
    );
    expect(skill).toContain('autopilot session human --reason-file');
  });

  it('does not own publication, draft state, Project state, or cleanup', () => {
    const prohibited = [
      'gh pr ready',
      'gh project item-edit',
      'gh pr comment',
      'git push',
      'git worktree remove',
      '--force-with-lease',
    ];
    for (const marker of prohibited) expect(skill).not.toContain(marker);
  });

  it('resolves mechanical conflicts only', () => {
    expect(skill).toContain('Mechanical');
    expect(skill).toContain('Semantic');
    expect(skill).toContain('never guess');
  });

  it('propagates merge-prep authority limits to any child', () => {
    expect(skill).toMatch(
      /every[\s\S]*delegated-root prompt[\s\S]*worktree must remain\s+detached/i,
    );
    expect(skill).toMatch(
      /every[\s\S]*delegated-root prompt[\s\S]*`autopilot session` operations are prohibited/i,
    );
    expect(skill).toContain('create local commits only');
    expect(skill).toContain('must go through `stage:run`');
  });

  it('keeps merge-prep payloads outside the detached worktree', () => {
    expect(skill).toContain('SESSION_REPORT_DIR');
    expect(skill).toContain('dirname -- "$JINN_AUTOPILOT_SESSION_MANIFEST"');
    expect(skill).toContain('"$SESSION_REPORT_DIR/merge-prep-summary.md"');
    expect(skill).toContain('"$SESSION_REPORT_DIR/human-reason.md"');
    expect(skill).toMatch(/reports directory[\s\S]*outside the supplied worktree/);
  });
});

describe('operator workflow contract', () => {
  const engDay = read('.claude/skills/eng-day/SKILL.md');
  const mergeBatch = read('.claude/skills/merge-batch/SKILL.md');
  const mergeMechanics = read(
    '.claude/skills/merge-batch/references/merge-mechanics.md',
  );
  const mergeResults = read(
    '.claude/skills/merge-batch/references/RESULTS.md',
  );

  it('describes GitHub-derived state and local independent capacity', () => {
    expect(engDay).toContain('two-hour');
    expect(engDay).toContain('observe');
    expect(engDay).toContain('recover');
    expect(engDay).toContain('active');
    expect(engDay).toContain('per-runner');
    expect(engDay).toMatch(/GitHub is the sole shared\s+state/);
    expect(engDay).toContain('missing local worktree');
    expect(engDay).toContain('no global capacity');
  });

  it('reserves v2 merge authorization for the lifecycle evaluator', () => {
    expect(mergeBatch).toContain('must not merge a v2-managed PR');
    expect(mergeBatch).toContain('terminal review-ref marker');
    expect(mergeBatch).toContain('exact-head evaluator');
    expect(mergeBatch).toContain('legacy:false');
    expect(mergeBatch).toContain('v2Marked:true');
    expect(mergeBatch).toMatch(
      /(?:a )?missing body marker\s+never\s+proves/i,
    );
    expect(mergeBatch).toContain('positively proves no v2 ownership');
    expect(mergeMechanics).toContain('must not merge a v2-managed PR');
    expect(mergeMechanics).toContain('terminal review-ref marker');
  });

  it('keeps exact-head manual merge compatibility for legacy work', () => {
    expect(mergeBatch).toMatch(/legacy\/unmanaged[\s\S]*ordinary merge gate/i);
    expect(mergeBatch).toContain('--match-head-commit');
    expect(mergeMechanics).toContain('--paginate');
    expect(mergeMechanics).toContain('changed-file completeness');
    expect(mergeMechanics).toContain('changed_files');
    expect(mergeMechanics).toContain('3,000');
    expect(mergeMechanics).toContain('exact candidate base OID');
  });

  it('contains no admin approval or merge bypass', () => {
    for (const doc of [mergeBatch, mergeMechanics, mergeResults]) {
      expect(doc).not.toContain('gh pr review');
      expect(doc).not.toContain('--admin');
      expect(doc).not.toContain('admin-authorized');
      expect(doc).not.toContain('Admin/autopilot');
    }
  });
});

describe('v2 operator entry point and migration', () => {
  const packageJson = JSON.parse(
    read('packages/autopilot/package.json'),
  ) as { scripts: Record<string, string> };

  it('makes v2 the safe default and names the legacy fallback', () => {
    expect(packageJson.scripts.autopilot).toBe(
      'tsx scripts/run-autopilot-v2.ts',
    );
    expect(packageJson.scripts['autopilot:v2']).toBe(
      'tsx scripts/run-autopilot-v2.ts',
    );
    expect(packageJson.scripts['autopilot:legacy']).toBe(
      'tsx scripts/run-autopilot.ts',
    );
    expect(packageJson.scripts['autopilot:capability-probe']).toBe(
      'tsx scripts/probe-autopilot-v2-capabilities.ts',
    );
  });

  it('documents a preserve-first protocol cutover', () => {
    const runbook = read('docs/runbooks/autopilot-v2-cutover.md');
    expect(runbook).toContain('Do not run legacy and v2 dispatch concurrently');
    expect(runbook).toContain('observe');
    expect(runbook).toContain('recover');
    expect(runbook).toContain('active');
    expect(runbook).toContain('dirty worktrees');
    expect(runbook).toContain('ahead commits');
    expect(runbook).toContain('existing branches');
    expect(runbook).toContain('cleanup remains disabled');
    expect(runbook).toMatch(/same-host/i);
    expect(runbook).toMatch(/cross-host/i);
    expect(runbook).toContain('Hermes');
  });

  it('gates review activation on live ref-CAS capability proofs', () => {
    const runbook = read('docs/runbooks/autopilot-v2-cutover.md');
    expect(runbook).toContain('absent-ref');
    expect(runbook).toContain('expected-parent');
    expect(runbook).toContain('atomic');
    expect(runbook).toContain('both refs unchanged');
    expect(runbook).toContain('before review activation');
    expect(runbook).toContain('autopilot:capability-probe');
    expect(runbook).toContain('JINN_AUTOPILOT_CAPABILITY_ATTESTATION');
    expect(runbook).toContain('unset JINN_AUTOPILOT_CAPABILITY_ATTESTATION');
  });

  it('records the approved design as implemented but not activated', () => {
    const design = read(
      'docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md',
    );
    expect(design).toContain('**Document status:** approved');
    expect(design).toContain('**Implementation status:** implemented');
    expect(design).toContain('live activation has not occurred');
    expect(design).not.toContain('**Implementation status:** not started');
  });
});

describe('delegated-root prompt isolation', () => {
  for (const runtime of ['claude', 'hermes']) {
    it(`${runtime} uses attempt-scoped unique owner-only prompt files`, () => {
      const reference = read(
        `.claude/skills/autopilot-runtime/references/${runtime}.md`,
      );
      expect(reference).toContain('SESSION_REPORT_DIR');
      expect(reference).toContain('mktemp');
      expect(reference).toMatch(/mktemp "\$SESSION_REPORT_DIR\/[^"]*\.md\.XXXXXX"/);
      expect(reference).toContain('chmod 600');
      expect(reference).toContain('rm -f -- "$STAGE_PROMPT"');
      expect(reference).not.toContain('/tmp/stage-<N>-<stage>.md');
    });
  }
});
