import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stop from '../../../src/cli/commands/stop.js';
import { makeCommandCtx } from '@test/cli.js';
import { Store } from '../../../src/store/store.js';

describe('stop command', () => {
  it('is success-shaped when no pidfile exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.state).toBe('stopped');
    expect(parsed.pid).toBeNull();
    expect(parsed.killed).toBe(false);
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
});
