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
const workflowNames = ['implement-issue', 'review-pr', 'merge-prep'] as const;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('shared Autopilot runtime skill contract', () => {
  it('is consumed by all three canonical workflows', () => {
    for (const workflow of workflowNames) {
      const doc = read(join(skillsRoot, workflow, 'SKILL.md'));
      expect(doc).toContain('../autopilot-runtime/SKILL.md');
      expect(doc).toContain('JINN_AUTOPILOT_RUNTIME');
    }
  });

  it('keeps runtime mechanics in one shared skill and its references', () => {
    expect(existsSync(runtimeSkillPath)).toBe(true);
    expect(existsSync(claudeReferencePath)).toBe(true);
    expect(existsSync(hermesReferencePath)).toBe(true);

    const runtimeSkill = read(runtimeSkillPath);
    expect(runtimeSkill).toContain('references/claude.md');
    expect(runtimeSkill).toContain('references/hermes.md');

    for (const workflow of workflowNames) {
      const workflowRoot = join(skillsRoot, workflow);
      const doc = read(join(workflowRoot, 'SKILL.md'));
      expect(existsSync(join(workflowRoot, 'references', 'claude.md')))
        .toBe(false);
      expect(existsSync(join(workflowRoot, 'references', 'hermes.md')))
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

  it('makes Hermes review fan-out synchronous and fixes fresh depth-0 roots', () => {
    const hermes = read(hermesReferencePath);
    const review = read(join(skillsRoot, 'review-pr', 'SKILL.md'));

    expect(hermes).toMatch(/synchronous[\s\S]*parallel[\s\S]*delegate_task/i);
    expect(hermes).toMatch(/new\s+depth-0 Hermes process/);
    expect(hermes).toContain('yarn stage:run');
    expect(hermes).not.toContain('--runtime');
    expect(review).toContain('synchronous-parallel-child mechanism');
    expect(review).toContain('fresh-root mechanism');
    expect(review).toMatch(
      /review fix pass[\s\S]*fresh-root mechanism[\s\S]*fan out internally/i,
    );
  });

  it('keeps stage runtime selection inherited from the process', () => {
    for (const path of [claudeReferencePath, hermesReferencePath]) {
      const reference = read(path);
      expect(reference).toContain('JINN_AUTOPILOT_RUNTIME');
      expect(reference).toContain('yarn stage:run');
      expect(reference).not.toContain('--runtime');
    }
  });
});
