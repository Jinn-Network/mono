import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const skillsRoot = join(repoRoot, '.claude', 'skills');
const runtimeRoot = join(skillsRoot, 'autopilot-runtime');
const runtimeSkillPath = join(runtimeRoot, 'SKILL.md');
const claudeReferencePath = join(runtimeRoot, 'references', 'claude.md');
const hermesReferencePath = join(runtimeRoot, 'references', 'hermes.md');
const cursorReferencePath = join(runtimeRoot, 'references', 'cursor.md');
const workflowNames = ['implement-issue', 'review-pr', 'fix-child', 'reconcile'] as const;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('shared Autopilot runtime skill contract', () => {
  it('is consumed by all canonical workflows', () => {
    for (const workflow of workflowNames) {
      const doc = read(join(skillsRoot, workflow, 'SKILL.md'));
      expect(doc).toContain('../autopilot-runtime/SKILL.md');
    }
    for (const workflow of ['implement-issue', 'review-pr'] as const) {
      const doc = read(join(skillsRoot, workflow, 'SKILL.md'));
      expect(doc).toContain('JINN_AUTOPILOT_RUNTIME');
    }
  });

  it('keeps runtime mechanics in one shared skill and its references', () => {
    expect(existsSync(runtimeSkillPath)).toBe(true);
    expect(existsSync(claudeReferencePath)).toBe(true);
    expect(existsSync(hermesReferencePath)).toBe(true);
    expect(existsSync(cursorReferencePath)).toBe(true);

    const runtimeSkill = read(runtimeSkillPath);
    expect(runtimeSkill).toContain('references/claude.md');
    expect(runtimeSkill).toContain('references/hermes.md');
    expect(runtimeSkill).toContain('references/cursor.md');

    for (const workflow of workflowNames) {
      const workflowRoot = join(skillsRoot, workflow);
      const doc = read(join(workflowRoot, 'SKILL.md'));
      expect(existsSync(join(workflowRoot, 'references', 'claude.md')))
        .toBe(false);
      expect(existsSync(join(workflowRoot, 'references', 'hermes.md')))
        .toBe(false);
      expect(existsSync(join(workflowRoot, 'references', 'cursor.md')))
        .toBe(false);
      expect(doc).not.toContain('delegate_task');
      expect(doc).not.toContain('Agent-tool');
      expect(doc).not.toContain('yarn stage:run');
      expect(doc).not.toContain('--runtime claude');
      expect(doc).not.toContain('--runtime hermes');
    }
  });

  it('has no runtime-specific workflow copies', () => {
    for (const workflow of workflowNames) {
      expect(existsSync(join(skillsRoot, `${workflow}-hermes`, 'SKILL.md')))
        .toBe(false);
      expect(existsSync(join(skillsRoot, `${workflow}-claude`, 'SKILL.md')))
        .toBe(false);
    }
  });

  it('exposes the same canonical skills to Codex and Cursor harnesses', () => {
    for (const harness of ['.codex', '.cursor']) {
      for (const skill of ['autopilot-runtime', ...workflowNames]) {
        const link = join(repoRoot, harness, 'skills', skill);
        expect(readlinkSync(link)).toBe(`../../.claude/skills/${skill}`);
      }
    }
  });

  it('makes review fan-out a synchronous batch of sanitized depth-0 roots', () => {
    const claude = read(claudeReferencePath);
    const hermes = read(hermesReferencePath);
    const review = read(join(skillsRoot, 'review-pr', 'SKILL.md'));

    for (const reference of [claude, hermes]) {
      expect(reference).toMatch(
        /synchronous[\s\S]*parallel[\s\S]*separate `stage:run`/i,
      );
      expect(reference).toContain('yarn stage:run');
      expect(reference).not.toContain('delegate_task');
    }
    expect(hermes).toMatch(/new\s+depth-0 Hermes process/);
    expect(hermes).not.toContain('--runtime');
    expect(review).toContain('synchronous-parallel-root mechanism');
    expect(review).toContain('review-findings');
    expect(review).not.toContain('review-fix-publish');
  });

  it('keeps stage runtime selection inherited from the process', () => {
    for (const path of [claudeReferencePath, hermesReferencePath, cursorReferencePath]) {
      const reference = read(path);
      expect(reference).toContain('JINN_AUTOPILOT_RUNTIME');
      expect(reference).toContain('yarn stage:run');
      expect(reference).not.toContain('--runtime');
    }
  });

  it('preserves v2 attempt context without acquiring lifecycle authority', () => {
    const runtimeSkill = read(runtimeSkillPath);
    expect(runtimeSkill).toContain('JINN_AUTOPILOT_SESSION_MANIFEST');
    expect(runtimeSkill).toContain('supplied detached attempt worktree');
    expect(runtimeSkill).toContain('workflow-specific authority capsule');
    expect(runtimeSkill).toMatch(
      /stage process[\s\S]*must not inherit[\s\S]*`GH_TOKEN`/,
    );
    expect(runtimeSkill).toMatch(
      /stage process[\s\S]*must not inherit[\s\S]*`JINN_AUTOPILOT_SESSION_MANIFEST`/,
    );
    expect(runtimeSkill).toMatch(
      /does not read, advance, or replace\s+lifecycle authority/,
    );
    expect(runtimeSkill).toContain('No upstream Hermes change is required');
  });

  it('makes Cursor fan-out a synchronous batch of sanitized depth-0 roots', () => {
    const cursor = read(cursorReferencePath);
    expect(cursor).toMatch(
      /synchronous[\s\S]*parallel[\s\S]*separate `stage:run`/i,
    );
    expect(cursor).toMatch(/new depth-0 `agent -p` process/);
    expect(cursor).toContain('yarn stage:run');
    expect(cursor).not.toContain('--runtime');
    expect(cursor).toContain('.cursor/skills');
    expect(cursor).toContain('.claude/skills');
  });
});
