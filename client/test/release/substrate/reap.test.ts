import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { reapWorkspaces } from '../../../scripts/release/substrate-reap';

describe('substrate-reap', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-reap-'));
    await fs.mkdir(path.join(tmpRoot, 'workspaces'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function seedWorkspace(name: string, ageDays: number): Promise<void> {
    const wsDir = path.join(tmpRoot, 'workspaces', name);
    await fs.mkdir(wsDir, { recursive: true });
    const ageMs = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    await fs.writeFile(
      path.join(wsDir, '.created-by'),
      JSON.stringify({ runId: name, createdAt: new Date(ageMs).toISOString() }),
    );
    const time = new Date(ageMs);
    await fs.utimes(wsDir, time, time);
  }

  it('removes workspaces older than 7 days', async () => {
    await seedWorkspace('old-workspace', 10);
    await seedWorkspace('fresh-workspace', 1);

    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });

    expect(result.reaped).toEqual(['old-workspace']);
    await expect(fs.access(path.join(tmpRoot, 'workspaces', 'old-workspace'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpRoot, 'workspaces', 'fresh-workspace'))).resolves.toBeUndefined();
  });

  it('returns empty list when nothing is old enough', async () => {
    await seedWorkspace('fresh-1', 2);
    await seedWorkspace('fresh-2', 5);

    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });

    expect(result.reaped).toEqual([]);
    expect(result.kept).toHaveLength(2);
  });

  it('handles empty workspaces dir gracefully', async () => {
    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });
    expect(result.reaped).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('skips non-directory entries', async () => {
    await fs.writeFile(path.join(tmpRoot, 'workspaces', 'a-file.txt'), 'not a dir');
    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });
    expect(result.reaped).toEqual([]);
  });

  it('uses .created-by createdAt over a fresher dir mtime', async () => {
    // An old workspace whose dir mtime was just bumped (e.g. a nested
    // write) must still be reaped based on its recorded createdAt.
    const wsDir = path.join(tmpRoot, 'workspaces', 'old-but-touched');
    await fs.mkdir(wsDir, { recursive: true });
    const oldMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await fs.writeFile(
      path.join(wsDir, '.created-by'),
      JSON.stringify({ runId: 'old-but-touched', createdAt: new Date(oldMs).toISOString() }),
    );
    const now = new Date();
    await fs.utimes(wsDir, now, now);

    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });
    expect(result.reaped).toEqual(['old-but-touched']);
  });

  it('falls back to dir mtime when .created-by is absent', async () => {
    const wsDir = path.join(tmpRoot, 'workspaces', 'no-provenance');
    await fs.mkdir(wsDir, { recursive: true });
    const oldMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const time = new Date(oldMs);
    await fs.utimes(wsDir, time, time);

    const result = await reapWorkspaces({ substrateRoot: tmpRoot, maxAgeDays: 7 });
    expect(result.reaped).toEqual(['no-provenance']);
  });
});
