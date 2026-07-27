import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_HOOKS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../plugins/learner/hooks',
);
const HOOK = join(PLUGIN_HOOKS, 'post-tool-use');

function initRepo(repo: string): string {
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  writeFileSync(join(repo, 'a.py'), 'x = 1\n');
  execFileSync('git', ['add', 'a.py'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function runHook(workingDir: string, stdinObj: unknown): { status: number; stderr: string } {
  const stdin = JSON.stringify(stdinObj);
  try {
    execFileSync('python3', [HOOK], {
      cwd: workingDir,
      env: { ...process.env, WORKING_DIR: workingDir },
      input: stdin,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 1, stderr: e.stderr ?? '' };
  }
}

function diffsPath(workingDir: string): string {
  return join(workingDir, '.execute', 'intermediate-failure-diffs.json');
}

describe('learner PostToolUse(Failure) intermediate-failure-diffs hook (#2230)', () => {
  let workingDir: string;
  let repo: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-ifd-hook-'));
    repo = join(workingDir, 'repo');
    initRepo(repo);
    // Dirty tree vs HEAD — the failed-attempt boundary.
    writeFileSync(join(repo, 'a.py'), 'x = 2\n');
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('appends one entry on PostToolUseFailure + pytest + dirty tree', () => {
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'pytest -q' },
      error: 'Command exited with non-zero status code 1',
      is_interrupt: false,
    });
    expect(r.status).toBe(0);
    expect(existsSync(diffsPath(workingDir))).toBe(true);
    const arr = JSON.parse(readFileSync(diffsPath(workingDir), 'utf8')) as string[];
    expect(arr).toHaveLength(1);
    expect(arr[0]).toContain('a.py');
    expect(readFileSync(join(workingDir, '.execute', 'session-repo-base'), 'utf8').trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it('dedupes identical diffs on a second identical failure', () => {
    const payload = {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'pytest -q' },
      error: 'Command exited with non-zero status code 1',
      is_interrupt: false,
    };
    expect(runHook(workingDir, payload).status).toBe(0);
    expect(runHook(workingDir, payload).status).toBe(0);
    const arr = JSON.parse(readFileSync(diffsPath(workingDir), 'utf8')) as string[];
    expect(arr).toHaveLength(1);
  });

  it('ignores non-test Bash failures (ls)', () => {
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'ls /nope' },
      error: 'Command exited with non-zero status code 1',
      is_interrupt: false,
    });
    expect(r.status).toBe(0);
    expect(existsSync(diffsPath(workingDir))).toBe(false);
  });

  it('ignores PostToolUse with exit 0 for vitest', () => {
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'vitest run' },
      tool_response: { stdout: 'ok', stderr: '', exit_code: 0, interrupted: false, isImage: false },
    });
    expect(r.status).toBe(0);
    expect(existsSync(diffsPath(workingDir))).toBe(false);
  });

  it('captures PostToolUse when tool_response.exit_code is non-zero (defensive)', () => {
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: '', stderr: 'fail', exit_code: 1, interrupted: false, isImage: false },
    });
    expect(r.status).toBe(0);
    const arr = JSON.parse(readFileSync(diffsPath(workingDir), 'utf8')) as string[];
    expect(arr).toHaveLength(1);
  });

  it('no-ops when repo/.git is missing (exit 0)', () => {
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'pytest' },
      error: 'Command exited with non-zero status code 1',
    });
    expect(r.status).toBe(0);
    expect(existsSync(diffsPath(workingDir))).toBe(false);
  });

  it('skips interrupts', () => {
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'pytest' },
      error: 'Interrupted',
      is_interrupt: true,
    });
    expect(r.status).toBe(0);
    expect(existsSync(diffsPath(workingDir))).toBe(false);
  });
});
