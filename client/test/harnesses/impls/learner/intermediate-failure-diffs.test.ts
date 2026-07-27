import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTestCommand,
  workingTreeDiff,
  appendIntermediateFailureDiff,
  readIntermediateFailureDiffs,
  attachIntermediateFailureDiffs,
  INTERMEDIATE_FAILURE_DIFFS_FILE,
} from '../../../../src/harnesses/impls/learner/intermediate-failure-diffs.js';

describe('isTestCommand (port of session_bridge._is_test_command)', () => {
  it.each([
    ['pytest', true],
    ['pytest -q tests/', true],
    ['tox', true],
    ['jest', true],
    ['vitest', true],
    ['./run_tests.sh', true],
    ['bash run_tests.sh', true],
    ['yarn test', true],
    ['npm test', true],
    ['pnpm test', true],
    ['bun test', true],
    ['cargo test', true],
    ['go test', true],
    ['make test', true],
    ['ls', false],
    ['yarn build', false],
    ['npm run build', false],
    ['git status', false],
    ['', false],
    ['yarn', false],
  ])('%j → %s', (cmd, expected) => {
    expect(isTestCommand(cmd)).toBe(expected);
  });

  it('returns false on unparseable shell quoting', () => {
    expect(isTestCommand(`echo 'unterminated`)).toBe(false);
  });
});

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'tracked.txt'), 'v1\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('workingTreeDiff', () => {
  let repo: string;
  let base: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'jinn-ifd-repo-'));
    base = initRepo(repo);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns empty string on a clean tree', () => {
    expect(workingTreeDiff(repo, base)).toBe('');
  });

  it('includes tracked edits and untracked files without mutating the index', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    writeFileSync(join(repo, 'new.txt'), 'u\n');
    const beforeIndex = execFileSync('git', ['ls-files', '-s'], { cwd: repo, encoding: 'utf8' });
    const diff = workingTreeDiff(repo, base);
    const afterIndex = execFileSync('git', ['ls-files', '-s'], { cwd: repo, encoding: 'utf8' });
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain('tracked.txt');
    expect(diff).toContain('new.txt');
    expect(afterIndex).toBe(beforeIndex);
  });
});

describe('appendIntermediateFailureDiff / readIntermediateFailureDiffs', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-ifd-wd-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('ignores empty diffs and dedupes identical strings', () => {
    const store = join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE);
    appendIntermediateFailureDiff(store, '');
    appendIntermediateFailureDiff(store, 'diff --git a/x b/x\n');
    appendIntermediateFailureDiff(store, 'diff --git a/x b/x\n');
    appendIntermediateFailureDiff(store, 'diff --git a/y b/y\n');
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([
      'diff --git a/x b/x\n',
      'diff --git a/y b/y\n',
    ]);
  });

  it('returns [] when the store file is absent', () => {
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([]);
    expect(existsSync(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE))).toBe(false);
  });

  it('returns [] on corrupt JSON without throwing', () => {
    mkdirSync(join(workingDir, '.jinn'), { recursive: true });
    writeFileSync(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE), '{not-json');
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([]);
  });
});

describe('attachIntermediateFailureDiffs', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-ifd-attach-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('sets intermediateFailureDiffs only when the store is non-empty', () => {
    const store = join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE);
    appendIntermediateFailureDiff(store, 'diff-a\n');
    const withDiffs = attachIntermediateFailureDiffs(
      { venueRef: { name: 'claude-code-learner' }, gating: {} },
      workingDir,
    );
    expect(withDiffs.intermediateFailureDiffs).toEqual(['diff-a\n']);

    const emptyWd = mkdtempSync(join(tmpdir(), 'jinn-ifd-empty-'));
    try {
      const omitted = attachIntermediateFailureDiffs(
        { venueRef: { name: 'claude-code-learner' }, gating: {} },
        emptyWd,
      );
      expect(omitted.intermediateFailureDiffs).toBeUndefined();
    } finally {
      rmSync(emptyWd, { recursive: true, force: true });
    }
  });
});
