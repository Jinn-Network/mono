import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cursorSnapshotRule } from '../../../src/trajectory/harness-bundle-rules/cursor.js';
import { getRule } from '../../../src/trajectory/harness-bundle-rules/types.js';

describe('cursorSnapshotRule', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'cursor-home-'));
    repoRoot = await mkdtemp(path.join(tmpdir(), 'cursor-repo-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('declares the cursor tool brand', () => {
    expect(cursorSnapshotRule.tool).toBe('cursor');
  });

  it('registers itself on import', () => {
    expect(getRule('cursor')).toBe(cursorSnapshotRule);
  });

  it('includes <repoRoot>/.cursorrules and <repoRoot>/.cursorignore when repoRoot is supplied', async () => {
    const paths = await cursorSnapshotRule.candidatePaths({ home, repoRoot });
    expect(paths).toContain(path.join(repoRoot, '.cursorrules'));
    expect(paths).toContain(path.join(repoRoot, '.cursorignore'));
  });

  it('returns empty list when repoRoot is not supplied (cursor is repo-local)', async () => {
    const paths = await cursorSnapshotRule.candidatePaths({ home });
    expect(paths).toEqual([]);
  });

  it('returns one path per file under <repoRoot>/.cursor/rules/', async () => {
    const rulesDir = path.join(repoRoot, '.cursor', 'rules');
    await mkdir(path.join(rulesDir, 'sub'), { recursive: true });
    await writeFile(path.join(rulesDir, 'core.md'), 'core');
    await writeFile(path.join(rulesDir, 'sub', 'nested.md'), 'nested');

    const paths = await cursorSnapshotRule.candidatePaths({ home, repoRoot });
    expect(paths).toContain(path.join(rulesDir, 'core.md'));
    expect(paths).toContain(path.join(rulesDir, 'sub', 'nested.md'));
  });

  it('does not throw when .cursor/rules is absent', async () => {
    const paths = await cursorSnapshotRule.candidatePaths({ home, repoRoot });
    expect(Array.isArray(paths)).toBe(true);
    expect(paths).toContain(path.join(repoRoot, '.cursorrules'));
  });

  it('returns absolute paths', async () => {
    const paths = await cursorSnapshotRule.candidatePaths({ home, repoRoot });
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });
});
