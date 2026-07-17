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
const CLAUDE_ADAPTER_PATH = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'implement-issue',
  'references',
  'claude.md',
);
const HERMES_ADAPTER_PATH = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'implement-issue',
  'references',
  'hermes.md',
);

describe('implement-issue SKILL.md (#657 depth-fix)', () => {
  const doc = readFileSync(SKILL_PATH, 'utf8');

  it('documents the wired `stage:run` invocation', () => {
    expect(doc).toContain('stage:run');
  });

  it('documents depth-needing stages through the active adapter', () => {
    expect(doc).toContain('active adapter’s fresh-root mechanism');
  });

  it('does NOT contain the superseded blanket "fresh subagent" Step-3 rule', () => {
    expect(doc).not.toContain('Each stage is performed by dispatching a **fresh subagent**');
  });
});

describe('implement-issue canonical runtime adapters', () => {
  const doc = readFileSync(SKILL_PATH, 'utf8');

  it('has no copied Hermes lifecycle skill', () => {
    expect(existsSync(HERMES_SKILL_PATH)).toBe(false);
  });

  it('links both mechanics-only adapter references from the canonical skill', () => {
    expect(doc).toContain('references/claude.md');
    expect(doc).toContain('references/hermes.md');
    expect(doc).toContain('JINN_IMPLEMENT_ISSUE_ADAPTER');
  });

  it('ships both adapter references', () => {
    expect(existsSync(CLAUDE_ADAPTER_PATH)).toBe(true);
    expect(existsSync(HERMES_ADAPTER_PATH)).toBe(true);
  });

  it('keeps lifecycle gates out of the adapters', () => {
    for (const path of [CLAUDE_ADAPTER_PATH, HERMES_ADAPTER_PATH]) {
      const adapter = existsSync(path) ? readFileSync(path, 'utf8') : '';
      expect(adapter).not.toContain('## Step 1 — Read the issue');
      expect(adapter).not.toContain(
        '## Step 5 — Finding handling and escalation',
      );
      expect(adapter).not.toContain('## Step 6 — Shape variants');
    }
  });
});
