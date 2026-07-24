import { describe, expect, it, vi } from 'vitest';
import { createKillCommand, type KillDeps } from '../../../src/cli/commands/kill.js';
import { makeCommandCtx } from '@test/cli.js';
import type { JinnProcess } from '../../../src/lifecycle/process-discovery.js';

function makeDeps(overrides: Partial<KillDeps> = {}): KillDeps {
  return {
    enumerateJinnProcesses: () => [],
    killSignal: vi.fn(),
    processAlive: () => false,
    sleep: vi.fn().mockResolvedValue(undefined),
    cmdlineMatch: () => 'match',
    ...overrides,
  };
}

describe('kill command', () => {
  it('reports no processes found when enumeration is empty', async () => {
    const deps = makeDeps();
    const cmd = createKillCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.found).toEqual([]);
    expect(parsed.killed).toEqual([]);
    expect(parsed.forceKilled).toEqual([]);
    expect(exits).toEqual([]);
    expect(deps.killSignal).not.toHaveBeenCalled();
  });

  it('kills a single discovered process without --all', async () => {
    const found: JinnProcess[] = [{ pid: 1234, command: 'node dist/bin/jinn.js run' }];
    const deps = makeDeps({
      enumerateJinnProcesses: () => found,
      processAlive: () => false, // dead immediately after SIGTERM
    });
    const cmd = createKillCommand(deps);
    const { ctx, writes } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.found).toEqual([{ pid: 1234, command: 'node dist/bin/jinn.js run' }]);
    expect(parsed.killed).toEqual([1234]);
    expect(parsed.forceKilled).toEqual([]);
    expect(deps.killSignal).toHaveBeenCalledTimes(1);
    expect(deps.killSignal).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('refuses more than one match without --all', async () => {
    const found: JinnProcess[] = [
      { pid: 1234, command: 'node dist/bin/jinn.js run' },
      { pid: 5678, command: 'node dist/bin/jinn.js run' },
    ];
    const deps = makeDeps({ enumerateJinnProcesses: () => found });
    const cmd = createKillCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.killSignal).not.toHaveBeenCalled();
  });

  it('kills all discovered processes with --all', async () => {
    const found: JinnProcess[] = [
      { pid: 1234, command: 'node dist/bin/jinn.js run' },
      { pid: 5678, command: 'node dist/bin/jinn.js run' },
    ];
    const deps = makeDeps({
      enumerateJinnProcesses: () => found,
      processAlive: () => false,
    });
    const cmd = createKillCommand(deps);
    const { ctx, writes } = makeCommandCtx({ argv: ['--all'] });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.killed.sort()).toEqual([1234, 5678]);
    expect(deps.killSignal).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(deps.killSignal).toHaveBeenCalledWith(5678, 'SIGTERM');
  });

  it('escalates to SIGKILL after the SIGTERM timeout when the process never exits', async () => {
    const found: JinnProcess[] = [{ pid: 9999, command: 'node dist/bin/jinn.js run' }];
    const killSignal = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      enumerateJinnProcesses: () => found,
      killSignal,
      processAlive: () => true, // never exits on its own
      sleep,
    });
    const cmd = createKillCommand(deps);
    const { ctx, writes } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.killed).toEqual([9999]);
    expect(parsed.forceKilled).toEqual([9999]);
    expect(killSignal).toHaveBeenCalledWith(9999, 'SIGTERM');
    expect(killSignal).toHaveBeenCalledWith(9999, 'SIGKILL');
    expect(killSignal.mock.calls[0]).toEqual([9999, 'SIGTERM']);
    expect(killSignal.mock.calls[killSignal.mock.calls.length - 1]).toEqual([9999, 'SIGKILL']);
    expect(sleep).toHaveBeenCalled();
  });

  it('skips the SIGKILL when the pid is confirmed no longer a jinn process right before the final signal (#805 recycled-pid re-verify)', async () => {
    const found: JinnProcess[] = [{ pid: 4321, command: 'node dist/bin/jinn.js run' }];
    const killSignal = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      enumerateJinnProcesses: () => found,
      killSignal,
      processAlive: () => true, // still alive after the SIGTERM poll times out
      sleep,
      cmdlineMatch: () => 'no-match', // pid was recycled to an unrelated process
    });
    const cmd = createKillCommand(deps);
    const { ctx, writes } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.killed).toEqual([4321]);
    expect(parsed.forceKilled).toEqual([]);
    expect(killSignal).toHaveBeenCalledWith(4321, 'SIGTERM');
    expect(killSignal).not.toHaveBeenCalledWith(4321, 'SIGKILL');
  });

  it('still SIGKILLs when the pre-SIGKILL cmdline probe is unknown (ps unavailable) — fail toward completion', async () => {
    const found: JinnProcess[] = [{ pid: 4321, command: 'node dist/bin/jinn.js run' }];
    const killSignal = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      enumerateJinnProcesses: () => found,
      killSignal,
      processAlive: () => true,
      sleep,
      cmdlineMatch: () => 'unknown',
    });
    const cmd = createKillCommand(deps);
    const { ctx, writes } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.killed).toEqual([4321]);
    expect(parsed.forceKilled).toEqual([4321]);
    expect(killSignal).toHaveBeenCalledWith(4321, 'SIGKILL');
  });

  it('emits invalid_invocation for bad flags', async () => {
    const deps = makeDeps();
    const cmd = createKillCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--bogus'] });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
