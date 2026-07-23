// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

describe('single-surface workflow skill pins', () => {
  const implementIssue = read('.claude/skills/implement-issue/SKILL.md');
  const fixChild = read('.claude/skills/fix-child/SKILL.md');
  const reconcile = read('.claude/skills/reconcile/SKILL.md');
  const engDay = read('.claude/skills/eng-day/SKILL.md');
  const autopilotRuntime = read('.claude/skills/autopilot-runtime/SKILL.md');
  const mergeBatch = read('.claude/skills/merge-batch/SKILL.md');

  it('implement-issue uses three-op finalize without project-status authority', () => {
    expect(implementIssue).toContain('implementation-complete');
    expect(implementIssue).toContain('three-op finalize');
    expect(implementIssue).toContain('engine:review');
    expect(implementIssue).toContain('review:needs-human');
    expect(implementIssue).not.toMatch(/projects?\s+`?In Review`?/i);
    expect(implementIssue).not.toContain('setProjectStatus');
    expect(implementIssue).not.toContain('gh project item-edit');
  });

  it('fix-child closes via child-complete and never opens a PR', () => {
    expect(fixChild).toContain('child-complete');
    expect(fixChild).toContain('Never open a new PR');
    expect(fixChild).not.toContain('gh pr create');
  });

  it('reconcile uses child-complete and never instructs rebase-as-method', () => {
    expect(reconcile).toContain('child-complete');
    expect(reconcile).toContain('Never rebase');
    expect(reconcile).not.toMatch(/git rebase/i);
    expect(reconcile).not.toMatch(/rebase onto/i);
  });

  it('eng-day reads label triage and surfaces child work', () => {
    expect(engDay).toContain('effort:*');
    expect(engDay).toContain('priority:*');
    expect(engDay).toContain('review-finding');
    expect(engDay).toContain('reconcile');
    expect(engDay).toContain('paint-only');
    expect(engDay).not.toContain('merge-prep');
  });

  it('autopilot-runtime lists the current session verb roster', () => {
    expect(autopilotRuntime).toContain('review-findings');
    expect(autopilotRuntime).toContain('child-complete');
    expect(autopilotRuntime).toContain('fix-child');
    expect(autopilotRuntime).toContain('reconcile');
    expect(autopilotRuntime).toMatch(/follow-ups-file/);
    expect(autopilotRuntime).toMatch(/Deleted verbs/);
  });

  it('§5.1 documents approve with optional non-blocking follow-ups', () => {
    const spec = read('docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md');
    expect(spec).toContain('### 5.1');
    expect(spec).toMatch(/follow-ups-file/);
    expect(spec).toContain('jinn-autopilot:review-follow-up');
    expect(spec).toMatch(/does not enter BLOCKED-BY-CHILD|never.*openChildKinds/i);
  });

  it('merge-batch does not route v2 work through merge-prep or Status authority', () => {
    expect(mergeBatch).toContain('children ladder');
    expect(mergeBatch).not.toContain('merge-prep');
    expect(mergeBatch).not.toMatch(/Status.*authorit/i);
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
    expect(runbook).toContain('is on by default in active mode');
    expect(runbook).toContain('ci-blocked');
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
