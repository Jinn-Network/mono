import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  processPostToolUseFailure,
  readIntermediateFailureDiffs,
  SESSION_REPO_BASE_HEAD_FILE,
  INTERMEDIATE_FAILURE_DIFFS_FILE,
} from '../../../../src/harnesses/impls/learner/intermediate-failure-diffs.js';
import { resolvePluginRoot } from '../../../../src/harnesses/impls/learner/plugin-path.js';

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

describe('processPostToolUseFailure', () => {
  let workingDir: string;
  let repo: string;
  let base: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-ptuf-'));
    repo = join(workingDir, 'repo');
    base = initRepo(repo);
    mkdirSync(join(workingDir, '.jinn'), { recursive: true });
    writeFileSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE), `${base}\n`);
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('appends a non-empty diff for a failed Bash test command', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    processPostToolUseFailure(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'pytest -q' },
        error: 'Command exited with non-zero status code 1',
      }),
      { WORKING_DIR: workingDir },
    );
    const diffs = readIntermediateFailureDiffs(workingDir);
    expect(diffs.length).toBe(1);
    expect(diffs[0]).toContain('tracked.txt');
  });

  it('ignores non-test Bash failures', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    processPostToolUseFailure(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        error: 'Command exited with non-zero status code 1',
      }),
      { WORKING_DIR: workingDir },
    );
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([]);
  });

  it('ignores non-Bash tools', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    processPostToolUseFailure(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: { command: 'pytest' },
      }),
      { WORKING_DIR: workingDir },
    );
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([]);
  });

  it('no-ops when base HEAD file is missing', () => {
    rmSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE));
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    processPostToolUseFailure(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'yarn test' },
      }),
      { WORKING_DIR: workingDir },
    );
    expect(existsSync(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE))).toBe(false);
  });

  it('never throws on corrupt stdin', () => {
    expect(() => processPostToolUseFailure('not-json{', { WORKING_DIR: workingDir })).not.toThrow();
  });
});

describe('post-tool-use-failure bash wrapper', () => {
  it('is registered and executable; pipes stdin into the helper without failing the agent', () => {
    const pluginRoot = resolvePluginRoot();
    const hook = join(pluginRoot, 'hooks', 'post-tool-use-failure');
    const hooksJson = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    expect(hooksJson.hooks.PostToolUseFailure).toBeDefined();
    expect(existsSync(hook)).toBe(true);

    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-ptuf-bash-'));
    try {
      const repo = join(workingDir, 'repo');
      const base = initRepo(repo);
      mkdirSync(join(workingDir, '.jinn'), { recursive: true });
      writeFileSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE), `${base}\n`);
      writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
      chmodSync(hook, 0o755);
      execFileSync('bash', [hook], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          error: 'Command exited with non-zero status code 1',
        }),
        env: { ...process.env, WORKING_DIR: workingDir, CLAUDE_PLUGIN_ROOT: pluginRoot },
        encoding: 'utf8',
      });
      expect(readIntermediateFailureDiffs(workingDir).length).toBe(1);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
