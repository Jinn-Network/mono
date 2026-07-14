import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Doc-content regression guard for the #657 fix: the implement-issue SKILL.md
// must document the depth-needing stages as `claude -p` root sessions launched
// via `stage:run`, and must not silently regress to the superseded blanket
// "fresh subagent per stage" rule.
//
// REPO_ROOT is derived the same way as dispatch.test.ts:
//   test → packages/autopilot → packages → repo root
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'implement-issue', 'SKILL.md');

describe('implement-issue SKILL.md (#657 depth-fix)', () => {
  const doc = readFileSync(SKILL_PATH, 'utf8');

  it('documents the wired `stage:run` invocation', () => {
    expect(doc).toContain('stage:run');
  });

  it('documents depth-needing stages as root sessions', () => {
    expect(doc.toLowerCase()).toContain('root session');
  });

  it('does NOT contain the superseded blanket "fresh subagent" Step-3 rule', () => {
    expect(doc).not.toContain('Each stage is performed by dispatching a **fresh subagent**');
  });
});
