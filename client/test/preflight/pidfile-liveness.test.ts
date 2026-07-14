import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkPidfileLiveness } from '../../src/preflight/pidfile-liveness.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

describe('pidfile-liveness preflight', () => {
  let tmp: string;
  let pidPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-pidfile-liveness-'));
    pidPath = join(tmp, 'daemon.pid');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    __resetExecSyncForTesting();
  });

  it('returns proceed when no pidfile exists', () => {
    expect(checkPidfileLiveness({ pidPath })).toEqual({ decision: 'proceed' });
  });

  it('returns unlink-stale when the pidfile is malformed (not a number)', () => {
    writeFileSync(pidPath, 'not-a-pid\n', 'utf-8');
    const decision = checkPidfileLiveness({ pidPath });
    expect(decision).toMatchObject({ decision: 'unlink-stale', reason: 'malformed', pidfilePath: pidPath });
  });

  it('returns unlink-stale on ESRCH (recorded PID is gone)', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({ decision: 'unlink-stale', pid: 987654, reason: 'esrch' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('returns refuse when the recorded PID is alive and is a jinn daemon', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({ decision: 'refuse', pid: 987654, reason: 'alive' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reclaims a pidfile recording a live pid whose cmdline is not a jinn daemon (recycled pid / #805)', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'python train.py\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({
        decision: 'unlink-stale',
        pid: 987654,
        reason: 'not-jinn',
        pidfilePath: pidPath,
      });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('refuses (fails closed) when the cmdline probe is unknown because ps throws (#805)', () => {
    // A real jinn daemon plus a ps failure (permissions, missing/odd ps in a
    // minimal container) must NOT be misclassified as reclaimable — that
    // would let `jinn run` start a second daemon against the same
    // store/wallet while the first is still alive.
    writeFileSync(pidPath, '987654\n', 'utf-8');
    __setExecSyncForTesting(() => {
      throw new Error('ps: command not found');
    });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({ decision: 'refuse', pid: 987654, reason: 'alive' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reclaims a pidfile recording PID 1 (container PID-1 / #805) instead of refusing', () => {
    // In a container the daemon is PID 1; on restart the pidfile on the
    // persistent volume outlives the container and `process.kill(1, 0)`
    // always succeeds, so the old probe-first classifier returned
    // refuse/'alive' and the daemon crash-looped. The self/PID-1 branch must
    // classify *before* the liveness probe.
    writeFileSync(pidPath, '1\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({
        decision: 'unlink-stale',
        pid: 1,
        reason: 'self-or-pid1-container',
        pidfilePath: pidPath,
      });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reclaims a pidfile recording our own process.pid (stale self record)', () => {
    writeFileSync(pidPath, `${process.pid}\n`, 'utf-8');
    const decision = checkPidfileLiveness({ pidPath });
    expect(decision).toMatchObject({
      decision: 'unlink-stale',
      pid: process.pid,
      reason: 'self-or-pid1-container',
      pidfilePath: pidPath,
    });
  });

  it('returns refuse on EPERM (process exists but owned by another user)', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({ decision: 'refuse', pid: 987654, reason: 'eperm' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('treats unknown errno conservatively as refuse', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EIO') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });
    try {
      const decision = checkPidfileLiveness({ pidPath });
      // Conservative: if we can't classify the errno, the safe move is to
      // refuse (don't risk trampling a daemon we just don't understand).
      expect(decision).toMatchObject({ decision: 'refuse', pid: 987654, reason: 'unknown' });
    } finally {
      killSpy.mockRestore();
    }
  });
});
