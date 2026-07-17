import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stop from '../../../src/cli/commands/stop.js';
import { makeCommandCtx } from '@test/cli.js';
import { Store } from '../../../src/store/store.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../../src/lifecycle/process-discovery.js';

describe('stop command', () => {
  // Deterministic by default: no orphaned processes discovered, regardless
  // of what's actually running on the host machine (#805 — operators
  // routinely have real stray jinn daemons around, which must not leak into
  // these unit tests). Individual tests override this to exercise the
  // enumeration fallback.
  beforeEach(() => {
    __setExecSyncForTesting(() => '');
  });
  afterEach(() => {
    __resetExecSyncForTesting();
    vi.restoreAllMocks();
  });

  it('is success-shaped when no pidfile exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.state).toBe('stopped');
    expect(parsed.pid).toBeNull();
    expect(parsed.killed).toBe(false);
    expect(parsed.discoveredPids).toBeUndefined();
    expect(exits).toEqual([]);
  });

  it('reads the pidfile and reports the pid on success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    writeFileSync(join(dir, 'daemon.pid'), '99999\n');
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    // PID 99999 almost certainly doesn't exist — stop should still emit a
    // success-shaped response with killed=false rather than an envelope.
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.pid).toBe(99999);
    expect(typeof parsed.killed).toBe('boolean');
  });

  it('removes stale pidfiles and clears persisted running state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    const dbPath = join(dir, 'jinn.db');
    const store = new Store(dbPath);
    try {
      store.setShutdownState('running');
    } finally {
      store.close();
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ dbPath, earningDir: dir }), 'utf8');
    writeFileSync(join(dir, 'daemon.pid'), '99999\n');

    const { ctx, writes } = makeCommandCtx({ argv: ['--config', join(dir, 'config.json')] });
    await stop.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      state: 'stopped',
      pid: 99999,
      killed: false,
      pidfileRemoved: true,
      stalePidfileCleaned: true,
    });
    expect(parsed.discoveredPids).toBeUndefined();
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
    const verifyStore = new Store(dbPath);
    try {
      expect(verifyStore.getShutdownState()).toBe('clean');
    } finally {
      verifyStore.close();
    }
  });

  it('emits invalid_invocation for bad flags', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--humna'] });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('#805: falls through to cmdline enumeration and signals discovered processes when the pidfile is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    __setExecSyncForTesting(() =>
      [' 55555 node /opt/jinn/dist/bin/jinn.js run', ' 66666 zsh'].join('\n'),
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.state).toBe('stopping');
    expect(parsed.pid).toBeNull();
    expect(parsed.killed).toBe(true);
    expect(parsed.discoveredPids).toEqual([55555]);
    expect(killSpy).toHaveBeenCalledWith(55555, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('#805: falls through to cmdline enumeration when the recorded pidfile pid is stale (ESRCH)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    writeFileSync(join(dir, 'daemon.pid'), '77777\n');
    __setExecSyncForTesting(() => ' 88888 node /opt/jinn/dist/bin/jinn.js run');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === 77777) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true as never;
    });
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.pid).toBe(77777);
    expect(parsed.stalePidfileCleaned).toBe(true);
    expect(parsed.pidfileRemoved).toBe(true);
    expect(parsed.killed).toBe(true);
    expect(parsed.discoveredPids).toEqual([88888]);
    expect(killSpy).toHaveBeenCalledWith(88888, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('#805: treats a recorded pid whose cmdline is not a jinn daemon (recycled pid) as stale and falls through to enumeration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    writeFileSync(join(dir, 'daemon.pid'), '55501\n');
    __setExecSyncForTesting((cmd) => {
      if (String(cmd).includes('-p 55501')) return 'python train.py\n';
      return ' 66601 node /opt/jinn/dist/bin/jinn.js run';
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.pid).toBe(55501);
    expect(parsed.stalePidfileCleaned).toBe(true);
    expect(parsed.pidfileRemoved).toBe(true);
    expect(parsed.killed).toBe(true);
    expect(parsed.discoveredPids).toEqual([66601]);
    expect(killSpy).not.toHaveBeenCalledWith(55501, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(66601, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('#805: enumeration fallback signals nothing and reports ambiguousPids when more than one jinn process is discovered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    __setExecSyncForTesting(() =>
      [
        ' 11111 node /opt/jinn/dist/bin/jinn.js run',
        ' 22222 node /opt/jinn/dist/bin/jinn.js run',
      ].join('\n'),
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.state).toBe('stopped');
    expect(parsed.killed).toBe(false);
    expect(parsed.discoveredPids).toBeUndefined();
    expect(parsed.ambiguousPids.slice().sort()).toEqual([11111, 22222]);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('#805: missing pidfile + no discovered processes reports plain stopped (no regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    // beforeEach already pins execSync to return '' — nothing discovered.
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.state).toBe('stopped');
    expect(parsed.killed).toBe(false);
    expect(parsed.discoveredPids).toBeUndefined();
  });
});
