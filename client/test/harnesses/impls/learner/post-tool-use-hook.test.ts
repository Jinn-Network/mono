import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 't@test'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repo, encoding: 'utf8' });
  writeFileSync(join(repo, 'a.py'), 'x = 1\n');
  spawnSync('git', ['add', 'a.py'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: repo, encoding: 'utf8' });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  return (head.stdout ?? '').trim();
}

function runHook(
  workingDir: string,
  stdinObj: unknown,
): { status: number; stdout: string; stderr: string } {
  const stdin = JSON.stringify(stdinObj);
  const r = spawnSync('python3', [HOOK], {
    cwd: workingDir,
    env: { ...process.env, WORKING_DIR: workingDir },
    input: stdin,
    encoding: 'utf8',
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function expectHookOk(r: { status: number; stdout: string }): void {
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
}

function diffsPath(workingDir: string): string {
  return join(workingDir, '.execute', 'intermediate-failure-diffs.json');
}

describe('learner PostToolUse(Failure) intermediate-failure-diffs hook (#2230)', () => {
  let workingDir: string;
  let repo: string;
  let baseHead: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-ifd-hook-'));
    repo = join(workingDir, 'repo');
    baseHead = initRepo(repo);
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
    expectHookOk(r);
    expect(existsSync(diffsPath(workingDir))).toBe(true);
    const arr = JSON.parse(readFileSync(diffsPath(workingDir), 'utf8')) as string[];
    expect(arr).toHaveLength(1);
    expect(arr[0]).toContain('a.py');
    expect(readFileSync(join(workingDir, '.execute', 'session-repo-base'), 'utf8').trim()).toBe(
      baseHead,
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
    expectHookOk(runHook(workingDir, payload));
    expectHookOk(runHook(workingDir, payload));
    const arr = JSON.parse(readFileSync(diffsPath(workingDir), 'utf8')) as string[];
    expect(arr).toHaveLength(1);
  });

  it('ignores non-test Bash failures (ls) but still pins session base', () => {
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'ls /nope' },
      error: 'Command exited with non-zero status code 1',
      is_interrupt: false,
    });
    expectHookOk(r);
    expect(existsSync(diffsPath(workingDir))).toBe(false);
    expect(readFileSync(join(workingDir, '.execute', 'session-repo-base'), 'utf8').trim()).toBe(
      baseHead,
    );
  });

  it('ignores PostToolUse with exit 0 for vitest', () => {
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'vitest run' },
      tool_response: { stdout: 'ok', stderr: '', exit_code: 0, interrupted: false, isImage: false },
    });
    expectHookOk(r);
    expect(existsSync(diffsPath(workingDir))).toBe(false);
  });

  it('captures PostToolUse when tool_response.exit_code is non-zero (defensive)', () => {
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: '', stderr: 'fail', exit_code: 1, interrupted: false, isImage: false },
    });
    expectHookOk(r);
    const arr = JSON.parse(readFileSync(diffsPath(workingDir), 'utf8')) as string[];
    expect(arr).toHaveLength(1);
  });

  it('captures camelCase toolResponse / toolName PostToolUse payloads', () => {
    const r = runHook(workingDir, {
      hookEventName: 'PostToolUse',
      toolName: 'Bash',
      toolInput: { command: 'pytest' },
      toolResponse: { exitCode: 1 },
    });
    expectHookOk(r);
    const arr = JSON.parse(readFileSync(diffsPath(workingDir), 'utf8')) as string[];
    expect(arr).toHaveLength(1);
  });

  it('keeps the first-pinned session base after HEAD moves', () => {
    // Explore Bash pins base before any failure.
    expectHookOk(
      runHook(workingDir, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { exit_code: 0 },
      }),
    );
    expect(readFileSync(join(workingDir, '.execute', 'session-repo-base'), 'utf8').trim()).toBe(
      baseHead,
    );

    // Agent commits mid-session — base must not follow HEAD.
    writeFileSync(join(repo, 'a.py'), 'x = 3\n');
    spawnSync('git', ['add', 'a.py'], { cwd: repo, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'mid'], { cwd: repo, encoding: 'utf8' });
    writeFileSync(join(repo, 'a.py'), 'x = 4\n');

    expectHookOk(
      runHook(workingDir, {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'pytest' },
        error: 'Command exited with non-zero status code 1',
      }),
    );
    expect(readFileSync(join(workingDir, '.execute', 'session-repo-base'), 'utf8').trim()).toBe(
      baseHead,
    );
    const arr = JSON.parse(readFileSync(diffsPath(workingDir), 'utf8')) as string[];
    expect(arr).toHaveLength(1);
    expect(arr[0]).toContain('x = 4');
  });

  it('does not append when the working tree matches the session base', () => {
    writeFileSync(join(repo, 'a.py'), 'x = 1\n'); // clean vs base HEAD
    const r = runHook(workingDir, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'pytest' },
      error: 'Command exited with non-zero status code 1',
    });
    expectHookOk(r);
    expect(existsSync(diffsPath(workingDir))).toBe(false);
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
    expectHookOk(r);
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
    expectHookOk(r);
    expect(existsSync(diffsPath(workingDir))).toBe(false);
  });
});
