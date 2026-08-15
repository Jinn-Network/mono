import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureStableCwd, resolveStableCwd } from '../../src/preflight/stable-cwd.js';

describe('resolveStableCwd (pure)', () => {
  const homeDir = '/home/op';
  const sep = '/';

  it('deleted cwd + existing earningDir → chdir to earningDir', () => {
    const earningDir = '/home/op/.jinn-client/earning';
    const result = resolveStableCwd({
      currentCwd: '/tmp/scratch',
      earningDir,
      homeDir,
      exists: (p) => p === earningDir,
      sep,
    });
    expect(result.needsChdir).toBe(true);
    expect(result.chosenCwd).toBe(earningDir);
    expect(result.logLine).toBe('[main] chdir to /home/op/.jinn-client/earning (was /tmp/scratch)');
  });

  it('deleted cwd + earningDir missing → falls to /home/op/.jinn-client', () => {
    const result = resolveStableCwd({
      currentCwd: '/tmp/scratch',
      earningDir: '/home/op/.jinn-client/earning',
      homeDir,
      exists: (p) => p === '/home/op/.jinn-client',
      sep,
    });
    expect(result.needsChdir).toBe(true);
    expect(result.chosenCwd).toBe('/home/op/.jinn-client');
  });

  it('deleted cwd + earningDir and .jinn-client missing → falls to homeDir', () => {
    const result = resolveStableCwd({
      currentCwd: '/tmp/scratch',
      earningDir: '/home/op/.jinn-client/earning',
      homeDir,
      exists: () => false,
      sep,
    });
    expect(result.needsChdir).toBe(true);
    expect(result.chosenCwd).toBe('/home/op');
  });

  it('cwd exists but outside $HOME → still chdir', () => {
    const earningDir = '/home/op/.jinn-client/earning';
    const result = resolveStableCwd({
      currentCwd: '/tmp/scratch',
      earningDir,
      homeDir,
      exists: (p) => p === '/tmp/scratch' || p === earningDir,
      sep,
    });
    expect(result.needsChdir).toBe(true);
    expect(result.chosenCwd).toBe(earningDir);
  });

  it('cwd exists AND under $HOME → no chdir', () => {
    const currentCwd = '/home/op/projects/foo';
    const result = resolveStableCwd({
      currentCwd,
      earningDir: '/home/op/.jinn-client/earning',
      homeDir,
      exists: () => true,
      sep,
    });
    expect(result.needsChdir).toBe(false);
    expect(result.chosenCwd).toBe(currentCwd);
    expect(result.logLine).toBe('[main] cwd /home/op/projects/foo is stable; no chdir needed');
  });

  it('cwd === homeDir → treated as under $HOME, no chdir', () => {
    const result = resolveStableCwd({
      currentCwd: '/home/op',
      earningDir: '/home/op/.jinn-client/earning',
      homeDir,
      exists: () => true,
      sep,
    });
    expect(result.needsChdir).toBe(false);
    expect(result.chosenCwd).toBe('/home/op');
  });
});

describe('ensureStableCwd (integration, real process.chdir)', () => {
  let outerCwd: string;

  afterEach(() => {
    // Restore the runner's cwd so we never leave it dangling for later tests.
    try {
      process.chdir(outerCwd);
    } catch {
      process.chdir(realpathSync(tmpdir()));
    }
  });

  it('recovers cwd after the launch dir is deleted out from under us', () => {
    outerCwd = process.cwd();

    // A live, stable target to chdir into.
    const earningDir = mkdtempSync(join(realpathSync(tmpdir()), 'jinn-stable-cwd-target-'));
    // An ephemeral launch dir we will delete to simulate the dangling-inode bug.
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'jinn-stable-cwd-scratch-'));

    try {
      process.chdir(scratch);
      rmSync(scratch, { recursive: true, force: true });
      // At this point process.cwd() itself throws ENOENT; ensureStableCwd must tolerate it.

      const result = ensureStableCwd({ earningDir });

      expect(result.needsChdir).toBe(true);
      expect(realpathSync(process.cwd())).toBe(realpathSync(earningDir));
    } finally {
      rmSync(earningDir, { recursive: true, force: true });
    }
  });
});
