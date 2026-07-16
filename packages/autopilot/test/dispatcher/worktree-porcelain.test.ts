import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWorktreePorcelain,
  extractWorktreeNumber,
  shortBranch,
  recoverStartedAt,
} from '../../src/dispatcher/worktree-porcelain.js';

describe('parseWorktreePorcelain', () => {
  it('parses multiple blocks with branch refs', () => {
    const output = [
      'worktree /repo/main',
      'HEAD aaaa',
      'branch refs/heads/next',
      '',
      'worktree /repo/jinn-mono_worktrees/418',
      'HEAD bbbb',
      'branch refs/heads/feat/418-thing',
      '',
    ].join('\n');

    expect(parseWorktreePorcelain(output)).toEqual([
      { worktreePath: '/repo/main', branchRef: 'refs/heads/next' },
      { worktreePath: '/repo/jinn-mono_worktrees/418', branchRef: 'refs/heads/feat/418-thing' },
    ]);
  });

  it('parses a detached-HEAD block with null branchRef', () => {
    const output = ['worktree /repo/detached-wt', 'HEAD cccc', 'detached', ''].join('\n');

    expect(parseWorktreePorcelain(output)).toEqual([
      { worktreePath: '/repo/detached-wt', branchRef: null },
    ]);
  });

  it('tolerates trailing blank lines and empty blocks', () => {
    const output = 'worktree /repo/a\nHEAD dddd\nbranch refs/heads/x\n\n\n\n';

    expect(parseWorktreePorcelain(output)).toEqual([
      { worktreePath: '/repo/a', branchRef: 'refs/heads/x' },
    ]);
  });
});

describe('extractWorktreeNumber', () => {
  it("extracts the issue number with prefix ''", () => {
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/418', '')).toBe(418);
  });

  it("extracts the PR number with prefix 'pr-'", () => {
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/pr-1762', 'pr-')).toBe(1762);
  });

  it("prefix '' rejects a pr-prefixed component", () => {
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/pr-1762', '')).toBeNull();
  });

  it("prefix 'pr-' rejects a bare-number component", () => {
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/418', 'pr-')).toBeNull();
  });

  it('rejects when the number is not the final path component', () => {
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/418/nested', '')).toBeNull();
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/pr-9/nested', 'pr-')).toBeNull();
  });

  it('rejects non-numeric and non-round-tripping candidates', () => {
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/abc', '')).toBeNull();
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/007', '')).toBeNull();
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees/pr-1x', 'pr-')).toBeNull();
  });

  it('only matches jinn-mono_worktrees as a proper path component, not a substring', () => {
    expect(
      extractWorktreeNumber('/home/u/jinn-mono_worktrees-backup/foo/jinn-mono_worktrees/418', ''),
    ).toBe(418);
    expect(extractWorktreeNumber('/home/u/jinn-mono_worktrees-backup/418', '')).toBeNull();
  });
});

describe('shortBranch', () => {
  it('strips the refs/heads/ prefix', () => {
    expect(shortBranch('refs/heads/feat/418-thing')).toBe('feat/418-thing');
  });

  it('returns other refs unchanged', () => {
    expect(shortBranch('refs/remotes/origin/next')).toBe('refs/remotes/origin/next');
  });
});

describe('recoverStartedAt', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('no markerPath argument → returns the worktree-derived value (one-signal behaviour)', () => {
    dir = mkdtempSync(join(tmpdir(), 'worktree-porcelain-'));
    const worktreePath = join(dir, 'worktree');
    mkdirSync(worktreePath);

    const result = recoverStartedAt(worktreePath);

    expect(result).toBeGreaterThan(0);
  });

  it('with markerPath → takes the max of marker mtime and worktree signal', () => {
    dir = mkdtempSync(join(tmpdir(), 'worktree-porcelain-'));
    const worktreePath = join(dir, 'worktree');
    mkdirSync(worktreePath);
    const markerPath = join(dir, 'marker');
    writeFileSync(markerPath, 'x');
    const future = new Date(Date.now() + 1_000_000);
    utimesSync(markerPath, future, future);

    const result = recoverStartedAt(worktreePath, markerPath);

    expect(Math.abs(result - future.getTime())).toBeLessThan(10);
  });

  it('neither path exists → returns 0 (unknown-age sentinel)', () => {
    dir = mkdtempSync(join(tmpdir(), 'worktree-porcelain-'));

    const result = recoverStartedAt(join(dir, 'no-worktree'), join(dir, 'no-marker'));

    expect(result).toBe(0);
  });
});
