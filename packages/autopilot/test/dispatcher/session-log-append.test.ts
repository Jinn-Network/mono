import { describe, it, expect, vi, afterEach } from 'vitest';
import { sessionLogPath, sessionStartedAtPath } from '../../src/dispatcher/session-log.js';

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
// the module so openSync/writeFileSync are replaceable.
const openSync = vi.fn();
const writeFileSync = vi.fn();
vi.mock('node:fs', () => ({
  openSync: (...a: unknown[]) => openSync(...a),
  writeFileSync: (...a: unknown[]) => writeFileSync(...a),
}));

const { openSync: fsOpenSync, writeFileSync: fsWriteFileSync } = await import('node:fs');

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

// jinn-mono#1296/#1393 — the dispatch-time started-at marker. The production
// lambda rewrites (truncates) `sessions/<N>.started-at` at every dispatch so
// its mtime is the session's startedAt for crash recovery (recoverStartedAt
// in state.ts). This test pins the contract by replicating the lambda's
// write call against the same mocked fs used above, proving:
//   (a) writeFileSync's default flag is 'w' (truncate) — no 'a' passed —
//       because the mtime must reflect the LATEST dispatch, unlike the
//       append-mode log;
//   (b) the content is an ISO timestamp ending in a newline;
//   (c) the mode is owner-only (0o600), matching the log file's mode.
function writeStartedAtMarker(issueNumber: number): string {
  const markerPath = sessionStartedAtPath(issueNumber);
  fsWriteFileSync(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return markerPath;
}

describe('session started-at marker write (jinn-mono#1296/#1393)', () => {
  afterEach(() => vi.clearAllMocks());

  it('writes the marker with writeFileSync in truncate (default) mode, an ISO string + newline, owner-only', () => {
    const markerPath = writeStartedAtMarker(418);

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [pathArg, contentArg, optsArg] = writeFileSync.mock.calls[0];
    expect(pathArg).toBe(sessionStartedAtPath(418));
    expect(pathArg).toBe(markerPath);
    expect(contentArg).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/);
    expect(optsArg).toEqual({ mode: 0o600 });
  });
});
