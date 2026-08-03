/**
 * D0a P3 (#525/#562/#897): a CLI verb that signs Safe writes with the agent
 * EOA (`createDirectSafeBroadcaster`, `FleetBootstrapper`) shares a memory
 * space with nothing -- it is a separate OS process from any running `jinn
 * run` daemon, so the in-process `withEoaBroadcastLock` unification (P1/P2)
 * cannot serialize the two. `checkDaemonGuard` closes that gap by refusing
 * the CLI write outright when a live daemon is detected against the same
 * earning directory, reusing the existing `daemon.pid` read pattern
 * (`checkPidfileLiveness`) rather than inventing a new liveness mechanism.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DAEMON_GUARD_OPT_OUT_ENV,
  checkDaemonGuard,
  daemonGuardEnvelope,
} from '../../src/cli/daemon-guard.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

describe('checkDaemonGuard', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-daemon-guard-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    __resetExecSyncForTesting();
  });

  it('does not block when no daemon.pid file exists', () => {
    const result = checkDaemonGuard({ earningDir: tmp, env: {} });
    expect(result).toMatchObject({ blocked: false, reason: 'not-running' });
  });

  it('does not block when the recorded pid is dead (ESRCH)', () => {
    writeFileSync(join(tmp, 'daemon.pid'), '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      const result = checkDaemonGuard({ earningDir: tmp, env: {} });
      expect(result).toMatchObject({ blocked: false, reason: 'not-running' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('blocks when the recorded pid is alive and is a jinn daemon', () => {
    writeFileSync(join(tmp, 'daemon.pid'), '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const result = checkDaemonGuard({ earningDir: tmp, env: {} });
      expect(result).toMatchObject({ blocked: true, pid: 987654, reason: 'alive' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('blocks conservatively on EPERM (process exists, owned by another user)', () => {
    writeFileSync(join(tmp, 'daemon.pid'), '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      const result = checkDaemonGuard({ earningDir: tmp, env: {} });
      expect(result).toMatchObject({ blocked: true, pid: 987654, reason: 'eperm' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does not block a live daemon whose recorded pid was recycled by a non-jinn process (#805)', () => {
    writeFileSync(join(tmp, 'daemon.pid'), '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'python train.py\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const result = checkDaemonGuard({ earningDir: tmp, env: {} });
      expect(result).toMatchObject({ blocked: false, reason: 'not-running' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('is opted out via the explicit env var even when a daemon is alive', () => {
    writeFileSync(join(tmp, 'daemon.pid'), '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const result = checkDaemonGuard({
        earningDir: tmp,
        env: { [DAEMON_GUARD_OPT_OUT_ENV]: '1' },
      });
      expect(result).toMatchObject({ blocked: false, reason: 'opted-out' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('treats falsy opt-out values ("0", "false", "") as NOT opted out', () => {
    writeFileSync(join(tmp, 'daemon.pid'), '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      for (const raw of ['0', 'false', '']) {
        const result = checkDaemonGuard({
          earningDir: tmp,
          env: { [DAEMON_GUARD_OPT_OUT_ENV]: raw },
        });
        expect(result).toMatchObject({ blocked: true, reason: 'alive' });
      }
    } finally {
      killSpy.mockRestore();
    }
  });

  it('defaults to process.env when no env override is passed', () => {
    // No daemon.pid in tmp -- exercises the process.env fallback branch without
    // depending on the real environment's daemon state.
    const result = checkDaemonGuard({ earningDir: tmp });
    expect(result).toMatchObject({ blocked: false, reason: 'not-running' });
  });
});

describe('daemonGuardEnvelope', () => {
  it('builds an invalid_invocation envelope naming the blocking pid and the opt-out env var', () => {
    const envelope = daemonGuardEnvelope(
      { blocked: true, pid: 4242, pidfilePath: '/tmp/x/daemon.pid', reason: 'alive' },
      'jinn bootstrap --json',
    );
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.message).toContain('4242');
    expect(envelope.exampleCli).toBe('jinn bootstrap --json');
    expect(envelope.hint).toContain(DAEMON_GUARD_OPT_OUT_ENV);
    expect(envelope.details).toMatchObject({
      pid: 4242,
      pidfilePath: '/tmp/x/daemon.pid',
      reason: 'alive',
    });
  });
});
