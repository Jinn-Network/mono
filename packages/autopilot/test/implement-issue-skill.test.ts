import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const skillPath = join(repoRoot, '.claude', 'skills', 'implement-issue', 'SKILL.md');
const runtimeSkillPath = join(
  repoRoot,
  '.claude',
  'skills',
  'autopilot-runtime',
  'SKILL.md',
);
const claudeAdapterPath = join(
  repoRoot,
  '.claude',
  'skills',
  'autopilot-runtime',
  'references',
  'claude.md',
);
const hermesAdapterPath = join(
  repoRoot,
  '.claude',
  'skills',
  'autopilot-runtime',
  'references',
  'hermes.md',
);
const doc = readFileSync(skillPath, 'utf8');

describe('implement-issue v2 authority contract', () => {
  it('consumes an already-claimed early-draft attempt', () => {
    expect(doc).toContain('JINN_AUTOPILOT_SESSION_MANIFEST');
    expect(doc).toContain('already won');
    expect(doc).toContain('early draft PR');
    expect(doc).toContain('detached attempt worktree');
  });

  it('delegates every shared lifecycle mutation to the session protocol', () => {
    expect(doc).toContain('autopilot session checkpoint');
    expect(doc).toContain(
      'autopilot session implementation-complete --summary-file',
    );
    expect(doc).toContain('autopilot session human --reason-file');

    const prohibited = [
      'gh pr create',
      'gh pr ready',
      'gh project item-edit',
      'gh issue comment',
      'git worktree add',
      'git worktree remove',
      'git push origin',
      'engine:review',
    ];
    for (const marker of prohibited) expect(doc).not.toContain(marker);
  });

  it('makes implementation completion the only successful terminal handoff', () => {
    expect(doc).toMatch(
      /non-draft only after the\s+implementation session ends/,
    );
    expect(doc).toContain('ready-last');
    expect(doc).not.toContain('reviewed, app-tested **draft PR**');
    expect(doc).not.toContain('to a draft PR');
  });

  it('keeps session payloads outside the detached worktree', () => {
    expect(doc).toContain('SESSION_REPORT_DIR');
    expect(doc).toContain('dirname -- "$JINN_AUTOPILOT_SESSION_MANIFEST"');
    expect(doc).toContain(
      '"$SESSION_REPORT_DIR/implementation-summary.md"',
    );
    expect(doc).toContain('"$SESSION_REPORT_DIR/human-reason.md"');
    expect(doc).toMatch(/reports directory[\s\S]*outside the supplied worktree/);
  });
});

describe('implement-issue inner workflow contract', () => {
  it('keeps all eight canonical stage methodologies', () => {
    const mappings = [
      '| 1 — Design | `superpowers:brainstorming` |',
      '| 2 — Plan | `superpowers:writing-plans` |',
      '| 3 — Implement | `superpowers:test-driven-development` then `superpowers:executing-plans` |',
      '| 4 — Code review | `/code-review` |',
      '| 5 — Independent review | `superpowers:requesting-code-review` |',
      '| 6 — Security review | `/security-review` |',
      '| 7 — Jinn-app test | `testing-jinn-app` |',
      '| 8 — Verify + handoff | `superpowers:verification-before-completion` |',
    ];

    for (const mapping of mappings) expect(doc).toContain(mapping);
  });

  it('keeps the internal implementer/reviewer separation and fix loop', () => {
    expect(doc).toContain(
      'Stage 3 implementer and the Stage 5 reviewer must be different sessions',
    );
    expect(doc).toMatch(
      /Re-review after a fix stays with the\s+independent reviewer/,
    );
    expect(doc).toContain('There is no round-count budget');
  });

  it('publishes real commit progress after implementation and fix passes', () => {
    expect(doc).toMatch(
      /After every commit-producing stage or fix pass/,
    );
    expect(doc).toContain('autopilot session checkpoint');
  });

  it('propagates the detached-attempt authority boundary to every stage', () => {
    expect(doc).toContain('authority capsule');
    expect(doc).toMatch(
      /Every delegated-root prompt[\s\S]*early draft PR already exists/,
    );
    expect(doc).toMatch(
      /Every delegated-root prompt[\s\S]*must remain detached/,
    );
    expect(doc).toMatch(
      /Every delegated-root prompt[\s\S]*must not push/,
    );
    expect(doc).toMatch(
      /Every delegated-root prompt[\s\S]*must not invoke `autopilot session`/,
    );
    expect(doc).toMatch(
      /Every delegated-root prompt[\s\S]*must stop and report/,
    );
    expect(doc).toMatch(/Every delegated stage[\s\S]*`stage:run`/);
  });
});

describe('canonical runtime adapters', () => {
  it('keeps one shared runtime skill and both mechanics-only adapters', () => {
    expect(doc).toContain('../autopilot-runtime/SKILL.md');
    expect(existsSync(runtimeSkillPath)).toBe(true);
    expect(existsSync(claudeAdapterPath)).toBe(true);
    expect(existsSync(hermesAdapterPath)).toBe(true);
  });

  it('keeps lifecycle policy out of runtime adapters', () => {
    const forbidden = [
      'gh pr create',
      'autopilot session',
      'Blocked on',
      'engine:review',
      'git worktree remove',
    ];
    for (const path of [claudeAdapterPath, hermesAdapterPath]) {
      const adapter = readFileSync(path, 'utf8');
      for (const marker of forbidden) expect(adapter).not.toContain(marker);
    }
  });
});
