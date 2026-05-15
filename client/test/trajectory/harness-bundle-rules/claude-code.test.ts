import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { claudeCodeSnapshotRule } from '../../../src/trajectory/harness-bundle-rules/claude-code.js';
import { getRule } from '../../../src/trajectory/harness-bundle-rules/types.js';

describe('claudeCodeSnapshotRule', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'cc-home-'));
    repoRoot = await mkdtemp(path.join(tmpdir(), 'cc-repo-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('declares the claude-code tool brand', () => {
    expect(claudeCodeSnapshotRule.tool).toBe('claude-code');
  });

  it('registers itself on import (getRule resolves it)', () => {
    const rule = getRule('claude-code');
    expect(rule).toBe(claudeCodeSnapshotRule);
  });

  it('includes ~/.claude/CLAUDE.md, settings.json, and repoRoot CLAUDE.md', async () => {
    const paths = await claudeCodeSnapshotRule.candidatePaths({ home, repoRoot });
    expect(paths).toContain(path.join(home, '.claude', 'CLAUDE.md'));
    expect(paths).toContain(path.join(home, '.claude', 'settings.json'));
    expect(paths).toContain(path.join(repoRoot, 'CLAUDE.md'));
  });

  it('omits repoRoot CLAUDE.md when repoRoot is not provided', async () => {
    const paths = await claudeCodeSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(home, '.claude', 'CLAUDE.md'));
    expect(paths).toContain(path.join(home, '.claude', 'settings.json'));
    expect(paths.some((p) => p.endsWith(`${path.sep}CLAUDE.md`) && !p.startsWith(home))).toBe(false);
  });

  it('returns one path per file under ~/.claude/skills/ (recursive)', async () => {
    const skillsDir = path.join(home, '.claude', 'skills');
    await mkdir(path.join(skillsDir, 'one'), { recursive: true });
    await mkdir(path.join(skillsDir, 'two', 'nested'), { recursive: true });
    await writeFile(path.join(skillsDir, 'one', 'SKILL.md'), 'one');
    await writeFile(path.join(skillsDir, 'two', 'SKILL.md'), 'two');
    await writeFile(path.join(skillsDir, 'two', 'nested', 'helper.md'), 'helper');

    const paths = await claudeCodeSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(skillsDir, 'one', 'SKILL.md'));
    expect(paths).toContain(path.join(skillsDir, 'two', 'SKILL.md'));
    expect(paths).toContain(path.join(skillsDir, 'two', 'nested', 'helper.md'));
  });

  it('returns one path per file under ~/.claude/plugins/<plugin>/skills/', async () => {
    const pluginA = path.join(home, '.claude', 'plugins', 'plugin-a', 'skills');
    const pluginB = path.join(home, '.claude', 'plugins', 'plugin-b', 'skills', 'sub');
    await mkdir(pluginA, { recursive: true });
    await mkdir(pluginB, { recursive: true });
    await writeFile(path.join(pluginA, 'a-skill.md'), 'a');
    await writeFile(path.join(pluginB, 'b-skill.md'), 'b');

    const paths = await claudeCodeSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(pluginA, 'a-skill.md'));
    expect(paths).toContain(path.join(pluginB, 'b-skill.md'));
  });

  it('returns absolute paths (no relative segments)', async () => {
    const paths = await claudeCodeSnapshotRule.candidatePaths({ home, repoRoot });
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });

  it('does not throw when ~/.claude/skills and ~/.claude/plugins are absent', async () => {
    const paths = await claudeCodeSnapshotRule.candidatePaths({ home });
    expect(Array.isArray(paths)).toBe(true);
    // Always contains the fixed files regardless of dir absence.
    expect(paths).toContain(path.join(home, '.claude', 'CLAUDE.md'));
  });
});
