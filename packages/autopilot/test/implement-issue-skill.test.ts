import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Doc-content regression guard for the #657 fix: the implement-issue SKILL.md
// must document the depth-needing stages as fresh-root sessions launched via
// `stage:run`, and must not silently regress to the superseded blanket "fresh
// subagent per stage" rule.
//
// REPO_ROOT is derived the same way as dispatch.test.ts:
//   test → packages/autopilot → packages → repo root
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'implement-issue', 'SKILL.md');
const HERMES_SKILL_PATH = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'implement-issue-hermes',
  'SKILL.md',
);
const RUNTIME_SKILL_PATH = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'autopilot-runtime',
  'SKILL.md',
);
const CLAUDE_ADAPTER_PATH = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'autopilot-runtime',
  'references',
  'claude.md',
);
const HERMES_ADAPTER_PATH = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'autopilot-runtime',
  'references',
  'hermes.md',
);

describe('implement-issue SKILL.md (#657 depth-fix)', () => {
  const doc = readFileSync(SKILL_PATH, 'utf8');

  it('delegates runtime mechanics to the shared runtime skill', () => {
    expect(doc).toContain('../autopilot-runtime/SKILL.md');
    expect(doc).not.toContain('yarn stage:run');
  });

  it('documents depth-needing stages through the active adapter', () => {
    expect(doc).toContain('active adapter’s fresh-root mechanism');
  });

  it('owns the runtime-neutral stage methodology mapping', () => {
    const mappings = [
      '| 1 — Design | `superpowers:brainstorming` |',
      '| 2 — Plan | `superpowers:writing-plans` |',
      '| 3 — Implement | `superpowers:test-driven-development` then `superpowers:executing-plans` |',
      '| 4 — Code review | `/code-review` |',
      '| 5 — Independent review | `superpowers:requesting-code-review` |',
      '| 6 — Security review | `/security-review` |',
      '| 7 — Jinn-app test | `testing-jinn-app` |',
      '| 8 — Verify + PR | `superpowers:verification-before-completion` |',
    ];

    expect(doc).toContain('## Canonical stage methodologies');
    for (const mapping of mappings) expect(doc).toContain(mapping);
    expect(doc).toContain(
      'The active runtime adapter resolves these canonical method names',
    );
  });

  it('does NOT contain the superseded blanket "fresh subagent" Step-3 rule', () => {
    expect(doc).not.toContain('Each stage is performed by dispatching a **fresh subagent**');
  });

  it('documents the dispatcher package and interactive fallback', () => {
    expect(doc).toContain('JINN_AUTOPILOT_PACKAGE_DIR');
    expect(doc).toContain('<repo-root>/packages/autopilot');
    expect(doc).not.toContain(
      'yarn workspace @jinn-network/autopilot triage:check <N>',
    );
  });

  it("keeps retry dispatch on each stage's prescribed adapter mechanism", () => {
    expect(doc).not.toContain('dispatch a fix subagent');
    expect(doc).not.toContain('Subagent reports "done"');
    expect(doc).not.toContain('Stage 8 subagent reports success');
    expect(doc).toContain(
      'Re-run Stage 3 through the active adapter’s fresh-root mechanism',
    );
    expect(doc).toContain(
      'Re-run Stage 5 through the active adapter’s fresh-root mechanism',
    );
    expect(doc).toContain(
      'Re-run Stage 8 through the active adapter’s lightweight-child mechanism',
    );
  });
});

describe('implement-issue canonical runtime adapters', () => {
  const doc = readFileSync(SKILL_PATH, 'utf8');

  it('has no copied Hermes lifecycle skill', () => {
    expect(existsSync(HERMES_SKILL_PATH)).toBe(false);
  });

  it('links the single shared runtime skill from the canonical workflow', () => {
    expect(doc).toContain('../autopilot-runtime/SKILL.md');
    expect(doc).toContain('JINN_AUTOPILOT_RUNTIME');
    expect(doc).not.toContain('references/claude.md');
    expect(doc).not.toContain('references/hermes.md');
  });

  it('ships the shared skill and both adapter references', () => {
    expect(existsSync(RUNTIME_SKILL_PATH)).toBe(true);
    expect(existsSync(CLAUDE_ADAPTER_PATH)).toBe(true);
    expect(existsSync(HERMES_ADAPTER_PATH)).toBe(true);
  });

  it('keeps adapters constrained to mechanics-only headings', () => {
    const expectedHeadings = new Map([
      [
        CLAUDE_ADAPTER_PATH,
        [
          '# Claude runtime adapter',
          '## Fresh-root sessions',
          '## Synchronous parallel children',
          '## Lightweight children',
          '## Skill loading',
        ],
      ],
      [
        HERMES_ADAPTER_PATH,
        [
          '# Hermes runtime adapter',
          '## Finite-session invariant',
          '## Fresh-root sessions',
          '## Synchronous parallel children',
          '## Lightweight children',
          '## Skill loading',
        ],
      ],
    ]);

    for (const [path, headings] of expectedHeadings) {
      const adapter = readFileSync(path, 'utf8');
      expect(adapter.match(/^#{1,2} .+$/gm)).toEqual(headings);
    }
  });

  it('keeps lifecycle policy and deliverables out of the adapters', () => {
    const forbiddenLifecycleMarkers = [
      'Hard preconditions',
      'Human-surface gate',
      'Output the coordinator reads',
      'Finding handling',
      'needs-decision',
      'Full pipeline shapes',
      'gh pr create',
      'engine:review',
      'Closes #',
      'git worktree remove',
    ];

    for (const path of [CLAUDE_ADAPTER_PATH, HERMES_ADAPTER_PATH]) {
      const adapter = readFileSync(path, 'utf8');
      for (const marker of forbiddenLifecycleMarkers) {
        expect(adapter).not.toContain(marker);
      }
    }
  });
});

describe('implement-issue SKILL.md triage invocation', () => {
  const doc = readFileSync(SKILL_PATH, 'utf8');

  it('resolves one package directory for dispatched and interactive runs', () => {
    expect(doc).toContain(
      'AUTOPILOT_PACKAGE_DIR="${JINN_AUTOPILOT_PACKAGE_DIR:-<repo-root>/packages/autopilot}"',
    );
    expect(doc).toContain(
      'VERDICT_JSON=$(yarn --cwd "$AUTOPILOT_PACKAGE_DIR" triage:check <N>)',
    );
    expect(doc).not.toContain('yarn workspace @jinn-network/autopilot triage:check');
    expect(doc).not.toContain(
      '(cd "<repo-root>/packages/autopilot" && yarn triage:check <N>)',
    );
    expect(doc).not.toContain(
      'yarn --cwd "<repo-root>/packages/autopilot" triage:check <N>',
    );
  });

  it('aborts triage when the reality-check command fails', () => {
    const failureBlock = doc.match(
      /if ! VERDICT_JSON=\$\(yarn --cwd "\$AUTOPILOT_PACKAGE_DIR" triage:check <N>\); then[\s\S]*?\nfi/,
    );
    expect(failureBlock).not.toBeNull();
    expect(failureBlock?.[0]).toContain('exit 1');
    expect(doc).toContain(
      'If the CLI exits non-zero (gh/git unavailable, network failure, JSON parse error), **abort triage entirely**.',
    );
  });
});
