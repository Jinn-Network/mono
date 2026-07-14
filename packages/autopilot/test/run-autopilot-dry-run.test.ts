import { describe, it, expect, vi, afterEach } from 'vitest';
import { runDryRun, printReport } from '../scripts/run-autopilot.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { DispatcherConfig } from '../src/dispatcher/types.js';
import type { CommandRunner } from '../src/dispatcher/issue-source.js';
import type { CycleReport } from '../src/dispatcher/loop.js';
import { WallClock } from '../src/dispatcher/wall-clock.js';

// Regression test for #598 — before the fix, a `gh` rejection inside the
// inline dry-run body escaped to `main().catch(...)` and printed a raw
// stack trace. The fix wraps `runDryRun` in a try/catch that logs a
// friendly one-liner ending in "run `gh api rate_limit` to check budget"
// and calls `exit(1)`.

const CFG: DispatcherConfig = {
  ...DEFAULT_CONFIG,
  authorAllowlist: ['testuser'],
};

describe('runDryRun (regression for #598)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a friendly message and calls exit(1) when the runner rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Suppress the dry-run banner so the test output stays readable.
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const runner: CommandRunner = vi
      .fn()
      .mockRejectedValue(new Error('budget exhausted'));
    const exit = vi.fn<(code: number) => void>();
    const wallClock = new WallClock(60_000);

    await expect(
      runDryRun({ runner, exit, cfg: CFG, wallClock }),
    ).resolves.toBeUndefined();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const errMsg = consoleErrorSpy.mock.calls[0]?.[0];
    expect(errMsg).toEqual(expect.stringContaining('dry-run aborted'));
    expect(errMsg).toEqual(expect.stringContaining('budget exhausted'));
    expect(errMsg).toEqual(expect.stringContaining('gh api rate_limit'));
  });
});

// #533 AC#2: the dispatcher's cycle report includes each session's log-file
// path alongside its PID. printReport is the render of CycleReport.
describe('printReport — dispatched session log path + pid (#533 AC#2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function baseReport(): CycleReport {
    return {
      dispatched: [],
      skippedForThrottle: 0,
      drift: [],
      backpressureTripped: false,
      paused: [],
      skippedForAuthor: [],
      collected: [],
    };
  }

  it('renders each dispatched session as "#N pid=<pid> log=<path>"', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printReport(
      {
        ...baseReport(),
        dispatched: [
          { issueNumber: 418, pid: 9876, logPath: '/home/op/.jinn-client/autopilot/sessions/418.log' },
        ],
      },
      'Cycle report',
    );

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes('#418'));
    expect(line).toBeDefined();
    expect(line).toContain('pid=9876');
    expect(line).toContain('log=/home/op/.jinn-client/autopilot/sessions/418.log');
  });

  it('renders pid=unknown when the spawned pid is null', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printReport(
      {
        ...baseReport(),
        dispatched: [{ issueNumber: 501, pid: null, logPath: '/x/501.log' }],
      },
      'Cycle report',
    );

    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('#501'));
    expect(line).toContain('pid=unknown');
    expect(line).toContain('log=/x/501.log');
  });

  it('renders "(none)" when nothing was dispatched', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printReport(baseReport(), 'Cycle report');

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('dispatched: (none)'))).toBe(true);
  });
});
