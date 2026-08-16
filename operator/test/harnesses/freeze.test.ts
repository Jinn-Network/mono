import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';

describe('hashImplStateDir', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), 'freeze-test-a-'));
    dirB = await mkdtemp(join(tmpdir(), 'freeze-test-b-'));
  });

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('produces a sha256-shaped hex string', async () => {
    await writeFile(join(dirA, 'file.txt'), 'hello');
    const h = await hashImplStateDir(dirA);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for identical content (deterministic)', async () => {
    await writeFile(join(dirA, 'file.txt'), 'hello');
    await writeFile(join(dirB, 'file.txt'), 'hello');
    const hA = await hashImplStateDir(dirA);
    const hB = await hashImplStateDir(dirB);
    expect(hA).toBe(hB);
  });

  it('returns different hashes for different content', async () => {
    await writeFile(join(dirA, 'file.txt'), 'hello');
    await writeFile(join(dirB, 'file.txt'), 'world');
    const hA = await hashImplStateDir(dirA);
    const hB = await hashImplStateDir(dirB);
    expect(hA).not.toBe(hB);
  });

  it('order-independent over file system listing order', async () => {
    // Write files in different orders to dirA vs dirB; should still hash equal.
    await writeFile(join(dirA, 'a.txt'), 'A');
    await writeFile(join(dirA, 'b.txt'), 'B');
    await writeFile(join(dirA, 'c.txt'), 'C');

    await writeFile(join(dirB, 'c.txt'), 'C');
    await writeFile(join(dirB, 'a.txt'), 'A');
    await writeFile(join(dirB, 'b.txt'), 'B');

    expect(await hashImplStateDir(dirA)).toBe(await hashImplStateDir(dirB));
  });

  it('walks subdirectories recursively', async () => {
    await mkdir(join(dirA, 'sub'));
    await writeFile(join(dirA, 'sub', 'nested.txt'), 'nested-content');
    await mkdir(join(dirB, 'sub'));
    await writeFile(join(dirB, 'sub', 'nested.txt'), 'nested-content');
    expect(await hashImplStateDir(dirA)).toBe(await hashImplStateDir(dirB));
  });

  it('detects content changes in nested files', async () => {
    await mkdir(join(dirA, 'sub'));
    await writeFile(join(dirA, 'sub', 'nested.txt'), 'v1');
    const before = await hashImplStateDir(dirA);
    await writeFile(join(dirA, 'sub', 'nested.txt'), 'v2');
    const after = await hashImplStateDir(dirA);
    expect(before).not.toBe(after);
  });

  it('hashes empty directory to a stable canonical value', async () => {
    const h1 = await hashImplStateDir(dirA);
    const h2 = await hashImplStateDir(dirB);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
