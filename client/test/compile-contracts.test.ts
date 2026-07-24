/**
 * Regression for #1984: run-tier-2 runs T2.2 + T2.4 in parallel; both call
 * setupAnvilFixture() → compileContracts(). Concurrent Hardhat builds on the
 * same contracts/ tree race on artifacts/ and cache/build-info/.
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const accessMock = vi.fn();

// MOCK_JUSTIFICATION: node:child_process.spawn is the syscall boundary for
// compileContracts; we assert single-flight serialization without running solc.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: accessMock,
  };
});

function mockCompileChild(exitAfterMs = 0): EventEmitter & { stderr: EventEmitter; stdout: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  spawnMock.mockImplementation(() => {
    setTimeout(() => child.emit('exit', 0), exitAfterMs);
    return child;
  });
  return child;
}

describe('compileContracts', () => {
  afterEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    accessMock.mockReset();
  });

  it('serializes concurrent compile callers to a single yarn compile (#1984)', async () => {
    mockCompileChild(20);
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const { compileContracts } = await import('./e2e/task-first-helpers.js');
    await Promise.all([compileContracts(), compileContracts(), compileContracts()]);

    const compileCalls = spawnMock.mock.calls.filter(
      ([command, args]) => command === 'yarn' && (args as string[]).includes('compile'),
    );
    expect(compileCalls).toHaveLength(1);
  });

  it('skips yarn compile when the canary artifact is already present', async () => {
    accessMock.mockResolvedValue(undefined);

    const { compileContracts } = await import('./e2e/task-first-helpers.js');
    await compileContracts();

    const compileCalls = spawnMock.mock.calls.filter(
      ([command, args]) => command === 'yarn' && (args as string[]).includes('compile'),
    );
    expect(compileCalls).toHaveLength(0);
  });

  it('joins in-flight compile when the canary appears mid-build (#2107)', async () => {
    const exitDelayMs = 50;
    let compileExited = false;
    const child = mockCompileChild(exitDelayMs);
    child.on('exit', () => {
      compileExited = true;
    });

    let accessCount = 0;
    accessMock.mockImplementation(() => {
      accessCount += 1;
      if (accessCount === 1) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
      return Promise.resolve();
    });

    const { compileContracts } = await import('./e2e/task-first-helpers.js');
    const first = compileContracts();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(compileExited).toBe(false);

    const second = compileContracts();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondSettled).toBe(false);

    await Promise.all([first, second]);

    expect(compileExited).toBe(true);
    expect(accessMock).toHaveBeenCalledTimes(1);
    const compileCalls = spawnMock.mock.calls.filter(
      ([command, args]) => command === 'yarn' && (args as string[]).includes('compile'),
    );
    expect(compileCalls).toHaveLength(1);
  });
});
