import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { isHeadless, requestDaemonRestart } from '../../src/restart-daemon.js';

/**
 * Regression test for #289 — `'Restart node' button kills the daemon`.
 *
 * Before this fix, the operator-MCP restart handler in main.ts called
 * `process.exit(0)` directly. That stranded the operator: the panel went
 * 502-on-localhost, the terminal returned to a shell prompt, and the only
 * path back was a manual `jinn run` re-invocation.
 *
 * The fix replaces the bare exit with an in-process respawn: spawn a
 * detached copy of the current process inheriting argv + env, then exit
 * after a short delay so the child can bind the API port.
 *
 * Test surface:
 *  - In interactive mode (default), respawn IS invoked, child inherits
 *    argv[1..] and env, child is detached + unref'd, parent exits 0.
 *  - In headless mode (`JINN_NO_UI=1`), respawn is NOT invoked — the
 *    supervisor decides whether to restart.
 *  - Source-textual: main.ts no longer contains the bare-exit pattern in
 *    `onRestartRequested`. Catches future-regression-via-revert.
 */

function makeFakeChild() {
  return {
    unref: vi.fn(),
  };
}

describe('#289 — operator-triggered restart respawn', () => {
  describe('isHeadless predicate', () => {
    it('returns true when JINN_NO_UI=1', () => {
      expect(isHeadless({ JINN_NO_UI: '1' })).toBe(true);
    });

    it('returns false when JINN_NO_UI is unset', () => {
      expect(isHeadless({})).toBe(false);
    });

    it('returns false when JINN_NO_UI is any other value', () => {
      expect(isHeadless({ JINN_NO_UI: '0' })).toBe(false);
      expect(isHeadless({ JINN_NO_UI: 'true' })).toBe(false);
    });
  });

  describe('interactive mode (default)', () => {
    it('spawns a detached replacement with the same argv[1..] and env, then exits 0', async () => {
      const fakeChild = makeFakeChild();
      const spawnFn = vi.fn(() => fakeChild as never);
      const exitFn = vi.fn();
      const log = vi.fn();

      const env = { HOME: '/tmp/test-home', JINN_PASSWORD: 'secret' };
      const argv = ['/usr/bin/node', '/opt/jinn/dist/main.js', 'run', '--config', '/tmp/c.json'];

      const result = await requestDaemonRestart({
        env,
        argv,
        execPath: '/usr/bin/node',
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        exitFn,
        log,
        exitDelayMs: 0,
      });

      expect(result).toBe('respawned');

      // Spawn was called exactly once, with the node binary + argv[1..].
      expect(spawnFn).toHaveBeenCalledTimes(1);
      const [execPathArg, argsArg, optionsArg] = spawnFn.mock.calls[0]!;
      expect(execPathArg).toBe('/usr/bin/node');
      expect(argsArg).toEqual(['/opt/jinn/dist/main.js', 'run', '--config', '/tmp/c.json']);

      // Spawned detached + stdio inherit + env passed through.
      expect(optionsArg).toMatchObject({
        detached: true,
        stdio: 'inherit',
        env,
      });

      // Child was unref'd so the parent's exit doesn't take it down.
      expect(fakeChild.unref).toHaveBeenCalledTimes(1);

      // Parent exited 0.
      expect(exitFn).toHaveBeenCalledWith(0);
    });

    it('logs that it is respawning', async () => {
      const log = vi.fn();
      await requestDaemonRestart({
        env: {},
        argv: ['/usr/bin/node', '/main.js'],
        execPath: '/usr/bin/node',
        spawnFn: vi.fn(() => makeFakeChild() as never) as unknown as typeof import('node:child_process').spawn,
        exitFn: vi.fn(),
        log,
        exitDelayMs: 0,
      });
      const joined = log.mock.calls.map((c) => c[0]).join('\n');
      expect(joined).toMatch(/Restart requested/i);
      expect(joined).toMatch(/[Ss]pawning|[Rr]espawn/);
    });
  });

  describe('#561 — pre-spawn cleanup', () => {
    // Regression for the EADDRINUSE race: the parent must release its server
    // sockets (API on 7332, OTLP on 4317/4318) *before* spawning the child,
    // otherwise the child loses the bind race and dies with exitCode 11.
    it('awaits preSpawnCleanup before invoking spawnFn', async () => {
      const order: string[] = [];
      const fakeChild = makeFakeChild();
      const spawnFn = vi.fn(() => {
        order.push('spawn');
        return fakeChild as never;
      });
      const preSpawnCleanup = vi.fn(async () => {
        // Force at least one microtask boundary so a buggy implementation
        // that forgets to `await` the cleanup will land `spawn` before
        // `cleanup` in `order`.
        await new Promise((r) => setTimeout(r, 0));
        order.push('cleanup');
      });

      await requestDaemonRestart({
        env: {},
        argv: ['/usr/bin/node', '/main.js'],
        execPath: '/usr/bin/node',
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        exitFn: vi.fn(),
        log: vi.fn(),
        exitDelayMs: 0,
        preSpawnCleanup,
      });

      expect(preSpawnCleanup).toHaveBeenCalledTimes(1);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['cleanup', 'spawn']);
    });

    it('still spawns and exits if preSpawnCleanup throws (operator must not be stranded)', async () => {
      const spawnFn = vi.fn(() => makeFakeChild() as never);
      const exitFn = vi.fn();
      const log = vi.fn();
      const preSpawnCleanup = vi.fn(async () => {
        throw new Error('synthetic close failure');
      });

      const result = await requestDaemonRestart({
        env: {},
        argv: ['/usr/bin/node', '/main.js'],
        execPath: '/usr/bin/node',
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        exitFn,
        log,
        exitDelayMs: 0,
        preSpawnCleanup,
      });

      expect(result).toBe('respawned');
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(exitFn).toHaveBeenCalledWith(0);
      const joined = log.mock.calls.map((c) => c[0]).join('\n');
      expect(joined).toMatch(/preSpawnCleanup/);
      expect(joined).toMatch(/synthetic close failure/);
    });

    it('headless mode skips preSpawnCleanup entirely (supervisor owns lifecycle)', async () => {
      const spawnFn = vi.fn();
      const preSpawnCleanup = vi.fn(async () => undefined);

      await requestDaemonRestart({
        env: { JINN_NO_UI: '1' },
        argv: ['/usr/bin/node', '/main.js'],
        execPath: '/usr/bin/node',
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        exitFn: vi.fn(),
        log: vi.fn(),
        exitDelayMs: 0,
        preSpawnCleanup,
      });

      expect(spawnFn).not.toHaveBeenCalled();
      expect(preSpawnCleanup).not.toHaveBeenCalled();
    });
  });

  describe('headless mode (JINN_NO_UI=1)', () => {
    it('does NOT spawn a replacement; exits 0', async () => {
      const spawnFn = vi.fn();
      const exitFn = vi.fn();
      const log = vi.fn();

      const result = await requestDaemonRestart({
        env: { JINN_NO_UI: '1' },
        argv: ['/usr/bin/node', '/main.js', 'run'],
        execPath: '/usr/bin/node',
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        exitFn,
        log,
        exitDelayMs: 0,
      });

      expect(result).toBe('headless-exit');
      expect(spawnFn).not.toHaveBeenCalled();
      expect(exitFn).toHaveBeenCalledWith(0);

      // The log should make it obvious why we exited without respawning,
      // so an operator inspecting logs after a supervisor doesn't restart
      // the daemon understands what happened.
      const joined = log.mock.calls.map((c) => c[0]).join('\n');
      expect(joined).toMatch(/JINN_NO_UI/);
    });
  });

  describe('main.ts wiring', () => {
    const MAIN_PATH = join(__dirname, '../../src/main.ts');

    it('no longer contains the bare process.exit(0) in onRestartRequested', () => {
      const source = readFileSync(MAIN_PATH, 'utf8');
      // The exact pre-fix shape: an arrow function whose body is just the log
      // line + `process.exit(0)`. We assert the source no longer matches the
      // bare-exit pattern under onRestartRequested.
      const onRestartIdx = source.indexOf('onRestartRequested');
      expect(onRestartIdx).toBeGreaterThan(-1);
      const handlerWindow = source.slice(onRestartIdx, onRestartIdx + 500);
      expect(handlerWindow).not.toMatch(/process\.exit\(\s*0\s*\)/);
    });

    it('routes onRestartRequested through requestDaemonRestart', () => {
      const source = readFileSync(MAIN_PATH, 'utf8');
      expect(source).toMatch(/from\s+['"]\.\/restart-daemon\.js['"]/);
      // Handler body invokes requestDaemonRestart.
      const onRestartIdx = source.indexOf('onRestartRequested');
      const handlerWindow = source.slice(onRestartIdx, onRestartIdx + 500);
      expect(handlerWindow).toMatch(/requestDaemonRestart\s*\(/);
    });
  });
});
