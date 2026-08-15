import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { aiderSnapshotRule } from '../../../src/trajectory/harness-bundle-rules/aider.js';
import { getRule } from '../../../src/trajectory/harness-bundle-rules/types.js';

describe('aiderSnapshotRule', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'aider-home-'));
    repoRoot = await mkdtemp(path.join(tmpdir(), 'aider-repo-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('declares the aider tool brand', () => {
    expect(aiderSnapshotRule.tool).toBe('aider');
  });

  it('registers itself on import', () => {
    expect(getRule('aider')).toBe(aiderSnapshotRule);
  });

  it('includes ~/.aider.conf.yml', async () => {
    const paths = await aiderSnapshotRule.candidatePaths({ home, repoRoot });
    expect(paths).toContain(path.join(home, '.aider.conf.yml'));
  });

  it('includes <repoRoot>/.aider.conf.yml when repoRoot supplied', async () => {
    const paths = await aiderSnapshotRule.candidatePaths({ home, repoRoot });
    expect(paths).toContain(path.join(repoRoot, '.aider.conf.yml'));
  });

  it('omits repoRoot config when repoRoot is not supplied', async () => {
    const paths = await aiderSnapshotRule.candidatePaths({ home });
    expect(paths).toContain(path.join(home, '.aider.conf.yml'));
    expect(paths.some((p) => p !== path.join(home, '.aider.conf.yml') && p.endsWith('.aider.conf.yml'))).toBe(false);
  });

  it('returns absolute paths', async () => {
    const paths = await aiderSnapshotRule.candidatePaths({ home, repoRoot });
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });
});
