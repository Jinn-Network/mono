import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeSemanticAgentRunner,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/claude-semantic-agent.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  readonly kill = vi.fn();
}

describe('ClaudeSemanticAgentRunner', () => {
  it('uses an isolated credential-free home and read-only tool policy', async () => {
    process.env['HOME'] = '/Users/operator';
    process.env['XDG_CONFIG_HOME'] = '/Users/operator/.config';
    process.env['GH_TOKEN'] = 'must-not-leak';
    process.env['GIT_ASKPASS'] = '/Users/operator/bin/askpass';
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'claude-only-token';
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const remove = vi.fn().mockResolvedValue(undefined);
    const runner = new ClaudeSemanticAgentRunner({
      claudePath: '/opt/claude',
      model: 'claude-review-model',
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: vi.fn().mockResolvedValue('/tmp/jinn-semantic-home'),
      remove,
    });

    const pending = runner.run({
      prompt: 'Review the exact head.',
      cwd: '/tmp/exact-head',
      abort: new AbortController().signal,
    });
    queueMicrotask(() => {
      child.stdout.write('{"outcome":"approve"}');
      child.emit('exit', 0, null);
    });
    await expect(pending).resolves.toBe('{"outcome":"approve"}');

    const [command, args, options] = spawnFn.mock.calls[0]!;
    expect(command).toBe('/opt/claude');
    expect(args).toContain('dontAsk');
    expect(args).not.toContain('bypassPermissions');
    expect(args).toContain('Bash(gh:*)');
    expect(args).toContain('Bash(git push:*)');
    expect(args).toContain('claude-review-model');
    expect(options.cwd).toBe('/tmp/exact-head');
    expect(options.env).toMatchObject({
      HOME: '/tmp/jinn-semantic-home',
      XDG_CONFIG_HOME: '/tmp/jinn-semantic-home/xdg-config',
      XDG_DATA_HOME: '/tmp/jinn-semantic-home/xdg-data',
      XDG_CACHE_HOME: '/tmp/jinn-semantic-home/xdg-cache',
      GH_CONFIG_DIR: '/tmp/jinn-semantic-home/gh',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-only-token',
    });
    expect(options.env).not.toHaveProperty('GH_TOKEN');
    expect(options.env).not.toHaveProperty('GIT_ASKPASS');
    expect(remove).toHaveBeenCalledWith('/tmp/jinn-semantic-home');
  });
});
