import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  processAlive,
  readPidfile,
  enumerateJinnProcesses,
  pidMatchesJinn,
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

describe('processAlive', () => {
  it('returns true for the current process', () => {
    expect(processAlive(process.pid)).toBe(true);
  });
  it('returns false for an obviously-dead pid', () => {
    expect(processAlive(2 ** 22)).toBe(false);
  });
});

describe('readPidfile', () => {
  it('returns alive=false when the file does not exist', () => {
    const result = readPidfile(join(tmpdir(), 'jinn-does-not-exist-' + Date.now() + '.pid'));
    expect(result).toEqual({ pid: null, alive: false, isJinn: false });
  });

  it('parses a bare-pid pidfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pidfile-'));
    const path = join(dir, 'daemon.pid');
    writeFileSync(path, String(process.pid) + '\n');
    const result = readPidfile(path);
    expect(result.pid).toBe(process.pid);
    expect(result.alive).toBe(true);
    expect(typeof result.isJinn).toBe('boolean');
  });

  it('returns pid=null for a malformed pidfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pidfile-'));
    const path = join(dir, 'daemon.pid');
    writeFileSync(path, 'not-a-number\n');
    const result = readPidfile(path);
    expect(result.pid).toBeNull();
    expect(result.alive).toBe(false);
    expect(result.isJinn).toBe(false);
  });
});

describe('pidMatchesJinn (with injected execSync)', () => {
  beforeEach(() => {
    __resetExecSyncForTesting();
  });
  afterEach(() => {
    __resetExecSyncForTesting();
  });

  it('returns true when ps reports a jinn daemon cmdline', () => {
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    expect(pidMatchesJinn(123456)).toBe(true);
  });

  it('returns false when ps reports an unrelated cmdline', () => {
    __setExecSyncForTesting(() => 'python train.py\n');
    expect(pidMatchesJinn(123456)).toBe(false);
  });

  it('returns false when ps throws (pid gone between checks)', () => {
    __setExecSyncForTesting(() => {
      throw new Error('ps: no such process');
    });
    expect(pidMatchesJinn(123456)).toBe(false);
  });
});

describe('enumerateJinnProcesses (with injected execSync)', () => {
  beforeEach(() => {
    __resetExecSyncForTesting();
  });
  afterEach(() => {
    __resetExecSyncForTesting();
  });

  it('matches the production `node dist/bin/jinn.js run` invocation', () => {
    __setExecSyncForTesting(() =>
      [
        ' 1111 node /opt/jinn/dist/bin/jinn.js run',
        ' 2222 /usr/local/bin/node /home/op/.nvm/versions/node/v22/bin/jinn run',
        ' 3333 grep jinn',
        ' 4444 zsh',
      ].join('\n'),
    );
    const result = enumerateJinnProcesses();
    expect(result.map((p) => p.pid).sort()).toEqual([1111, 2222]);
  });

  it('excludes the current process pid', () => {
    __setExecSyncForTesting(() =>
      [
        ` ${process.pid} node dist/bin/jinn.js run`,
        ' 9999 node dist/bin/jinn.js run',
      ].join('\n'),
    );
    const result = enumerateJinnProcesses();
    expect(result.map((p) => p.pid)).toEqual([9999]);
  });

  it('returns [] when ps emits nothing useful', () => {
    __setExecSyncForTesting(() => '\n');
    expect(enumerateJinnProcesses()).toEqual([]);
  });

  it('returns [] when ps throws', () => {
    __setExecSyncForTesting(() => {
      throw new Error('ps not found');
    });
    expect(enumerateJinnProcesses()).toEqual([]);
  });

  it('does not match unrelated processes with "jinn" in their path', () => {
    __setExecSyncForTesting(() =>
      [
        ' 5555 vim /home/op/jinn-notes.md',
        ' 6666 cat /var/log/jinn.log',
        ' 7777 node /opt/jinn/dist/bin/jinn.js run --config=x',
      ].join('\n'),
    );
    const result = enumerateJinnProcesses();
    expect(result.map((p) => p.pid)).toEqual([7777]);
  });
});
