import { describe, it, expect, vi, afterEach } from 'vitest';
import { runDryRun } from '../scripts/run-eng-loop.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { DispatcherConfig } from '../src/dispatcher/types.js';
import type { CommandRunner } from '../src/dispatcher/issue-source.js';
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
