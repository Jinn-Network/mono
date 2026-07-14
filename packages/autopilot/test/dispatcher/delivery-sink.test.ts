import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GhPrSink } from '../../src/dispatcher/delivery-sink.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { SessionResult } from '../../src/dispatcher/types.js';

/**
 * Pins the existing GhPrSink.collect behaviour (issue #489): a pr-opened
 * result is verified via `gh pr view` before logging; escalations log their
 * status. No production change is made by these tests — they document the
 * contract the dispatcher relies on.
 */
describe('GhPrSink.collect', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function loggedText(): string {
    return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('verifies a pr-opened PR via `gh pr view` and logs it', async () => {
    const runner: CommandRunner = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ number: 42, state: 'OPEN', title: 'x' }));
    const sink = new GhPrSink(runner);

    const result: SessionResult = { issueNumber: 101, outcome: 'pr-opened', prNumber: 42 };
    await sink.collect(result);

    expect(runner).toHaveBeenCalledWith('gh', [
      'pr', 'view', '42',
      '--repo', 'Jinn-Network/mono',
      '--json', 'number,state,title',
    ]);
    const log = loggedText();
    expect(log).toContain('PR #42 verified');
    expect(log).toContain('state=OPEN');
  });

  it('does not call the runner when prNumber is missing', async () => {
    const runner: CommandRunner = vi.fn();
    const sink = new GhPrSink(runner);

    const result: SessionResult = { issueNumber: 102, outcome: 'pr-opened' };
    await sink.collect(result);

    expect(runner).not.toHaveBeenCalled();
    expect(loggedText()).toContain('prNumber is missing');
  });

  it('logs (does not throw) when `gh pr view` fails', async () => {
    const runner: CommandRunner = vi.fn().mockRejectedValue(new Error('no such PR'));
    const sink = new GhPrSink(runner);

    const result: SessionResult = { issueNumber: 103, outcome: 'pr-opened', prNumber: 99 };
    await expect(sink.collect(result)).resolves.toBeUndefined();

    expect(loggedText()).toContain('could not be verified');
  });

  it('logs an escalation with its status', async () => {
    const runner: CommandRunner = vi.fn();
    const sink = new GhPrSink(runner);

    const result: SessionResult = {
      issueNumber: 104,
      outcome: 'escalated',
      escalationStatus: 'blocked',
    };
    await sink.collect(result);

    expect(runner).not.toHaveBeenCalled();
    expect(loggedText()).toContain('escalated — status=blocked');
  });

  it('logs an escalation with status=unknown when escalationStatus is undefined', async () => {
    const runner: CommandRunner = vi.fn();
    const sink = new GhPrSink(runner);

    const result: SessionResult = { issueNumber: 105, outcome: 'escalated' };
    await sink.collect(result);

    expect(loggedText()).toContain('status=unknown');
  });
});
