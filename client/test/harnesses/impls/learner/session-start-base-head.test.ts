import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginRoot } from '../../../../src/harnesses/impls/learner/plugin-path.js';
import { SESSION_REPO_BASE_HEAD_FILE } from '../../../../src/harnesses/impls/learner/intermediate-failure-diffs.js';

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), '1\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('session-start records repo base HEAD', () => {
  let root: string;
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jinn-ss-'));
    workingDir = join(root, 'work');
    implStateDir = join(root, 'impl');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(implStateDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes .jinn/session-repo-base-head when repo/.git exists', () => {
    const head = initRepo(join(workingDir, 'repo'));
    const hook = join(resolvePluginRoot(), 'hooks', 'session-start');
    chmodSync(hook, 0o755);
    execFileSync('bash', [hook], {
      env: { ...process.env, IMPL_STATE_DIR: implStateDir, WORKING_DIR: workingDir },
      encoding: 'utf8',
    });
    const recorded = readFileSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE), 'utf8').trim();
    expect(recorded).toBe(head);
  });

  it('skips base-head write when repo is absent', () => {
    const hook = join(resolvePluginRoot(), 'hooks', 'session-start');
    execFileSync('bash', [hook], {
      env: { ...process.env, IMPL_STATE_DIR: implStateDir, WORKING_DIR: workingDir },
      encoding: 'utf8',
    });
    expect(existsSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE))).toBe(false);
  });
});
