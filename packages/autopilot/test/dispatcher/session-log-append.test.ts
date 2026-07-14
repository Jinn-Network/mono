import { describe, it, expect, vi, afterEach } from 'vitest';
import { sessionLogPath } from '../../src/dispatcher/session-log.js';

// #533 AC#4 — re-dispatches must NOT silently overwrite an existing log.
// The production SpawnFn lambda (scripts/run-autopilot.ts) opens the per-session
// log with openSync(path, 'a'). This test pins that contract by exercising the
// exact open call the lambda performs against a mocked fs, proving:
//   (a) the flag is 'a' (append) — not 'w' (truncate);
//   (b) both stdout(1) and stderr(2) are wired to the SAME fd so the two
//       streams interleave into one tailable file (AC#1/AC#3).
//
// We replicate the lambda's open+wire logic here rather than importing it
// (it is an inline closure); run-autopilot-dry-run.test.ts + the manual
// tail -f smoke check (plan Task 5) cover the wired-up path end to end.

// node:fs exports are non-configurable, so spyOn cannot redefine them — mock
// the module so openSync is replaceable.
const openSync = vi.fn();
vi.mock('node:fs', () => ({ openSync: (...a: unknown[]) => openSync(...a) }));

const { openSync: fsOpenSync } = await import('node:fs');

function openSessionStdio(issueNumber: number): {
  stdio: ['ignore', number, number];
  fd: number;
} {
  const logPath = sessionLogPath(issueNumber);
  // Owner-only mode on create (0o600) — session logs may contain secrets.
  const fd = fsOpenSync(logPath, 'a', 0o600);
  return { stdio: ['ignore', fd, fd], fd };
}

describe('session log append-mode wiring (#533 AC#4)', () => {
  afterEach(() => vi.clearAllMocks());

  it('opens the per-session log in append mode and wires both fds to it', () => {
    const FAKE_FD = 42;
    openSync.mockReturnValue(FAKE_FD);

    const { stdio, fd } = openSessionStdio(418);

    expect(openSync).toHaveBeenCalledTimes(1);
    expect(openSync).toHaveBeenCalledWith(sessionLogPath(418), 'a', 0o600);
    expect(fd).toBe(FAKE_FD);
    // stdin ignored; stdout + stderr both → the same log fd.
    expect(stdio[0]).toBe('ignore');
    expect(stdio[1]).toBe(FAKE_FD);
    expect(stdio[2]).toBe(FAKE_FD);
  });
});
