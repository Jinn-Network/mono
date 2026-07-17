import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  processAlive,
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

describe('pidMatchesJinn (with injected execSync)', () => {
  beforeEach(() => {
    __resetExecSyncForTesting();
  });
  afterEach(() => {
    __resetExecSyncForTesting();
  });

  it("returns 'match' when ps reports a jinn daemon cmdline", () => {
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    expect(pidMatchesJinn(123456)).toBe('match');
  });

  it("returns 'no-match' when ps reports a definitively unrelated cmdline", () => {
    __setExecSyncForTesting(() => 'python train.py\n');
    expect(pidMatchesJinn(123456)).toBe('no-match');
  });

  it("does not match `jinn run-summary.log` (run must be followed by whitespace or end-of-string, #805)", () => {
    __setExecSyncForTesting(() => 'jinn run-summary.log\n');
    expect(pidMatchesJinn(123456)).toBe('no-match');
  });

  it("returns 'unknown' (not 'no-match') when ps throws — a ps failure must not be misread as a confirmed non-jinn process (#805)", () => {
    __setExecSyncForTesting(() => {
      throw new Error('ps: no such process');
    });
    expect(pidMatchesJinn(123456)).toBe('unknown');
  });

  it("returns 'unknown' when ps succeeds but reports empty output", () => {
    __setExecSyncForTesting(() => '\n');
    expect(pidMatchesJinn(123456)).toBe('unknown');
  });

  it("returns 'match' for the tsx dev-mode invocation (`yarn jinn run` -> `tsx src/bin/jinn.ts run`, #805)", () => {
    __setExecSyncForTesting(
      () =>
        'node --require /repo/node_modules/tsx/dist/preflight.cjs --import file:///repo/node_modules/tsx/dist/loader.mjs /repo/client/src/bin/jinn.ts run\n',
    );
    expect(pidMatchesJinn(123456)).toBe('match');
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

  it('matches the tsx dev-mode invocation (`yarn jinn run` -> `tsx src/bin/jinn.ts run`, #805)', () => {
    __setExecSyncForTesting(() =>
      [
        ' 8888 node --require /repo/node_modules/tsx/dist/preflight.cjs --import file:///repo/node_modules/tsx/dist/loader.mjs /repo/client/src/bin/jinn.ts run',
        ' 9999 grep jinn',
      ].join('\n'),
    );
    const result = enumerateJinnProcesses();
    expect(result.map((p) => p.pid)).toEqual([8888]);
  });
});
