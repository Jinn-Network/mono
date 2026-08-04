/**
 * Issue #2407 M3 — the retry-loop ORDERING extracted into
 * `runBootstrapWithDegradeOpen` (earning/bootstrap-run.ts) is independently
 * testable via injected spies, unlike main.ts's inline loop.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runBootstrapWithDegradeOpen,
  SetupBootstrapHalted,
  type StoppableRecovery,
} from '../../src/earning/bootstrap-run.js';
import { buildEnvelope } from '../../src/errors/envelope.js';

function haltError() {
  return new SetupBootstrapHalted(buildEnvelope({ code: 'funding_required', message: 'needs funds' }));
}

describe('runBootstrapWithDegradeOpen ordering (#2407 M3)', () => {
  it('calls setReadiness(bootstrapping) before the first runBootstrap attempt', async () => {
    const calls: string[] = [];
    const runBootstrap = vi.fn().mockImplementation(async () => {
      calls.push('runBootstrap');
      return 'ok';
    });
    const setReadiness = vi.fn().mockImplementation((r: string) => calls.push(`readiness:${r}`));

    await runBootstrapWithDegradeOpen({
      runBootstrap,
      startDegraded: () => null,
      setReadiness,
      awaitRetry: async () => {},
    });

    expect(calls).toEqual(['readiness:bootstrapping', 'runBootstrap', 'readiness:ready']);
  });

  it('on a halt: startDegraded runs, then readiness flips degraded, then awaitRetry is awaited, ' +
    'then stop() resolves BEFORE the next runBootstrap, then readiness flips ready', async () => {
    const calls: string[] = [];
    let attempt = 0;
    let stopResolve: (() => void) | undefined;
    const stopPromise = new Promise<void>((resolve) => { stopResolve = resolve; });

    const handle: StoppableRecovery = {
      stop: vi.fn().mockImplementation(() => {
        calls.push('stop:called');
        return stopPromise.then(() => { calls.push('stop:resolved'); });
      }),
    };

    const runBootstrap = vi.fn().mockImplementation(async () => {
      attempt += 1;
      calls.push(`runBootstrap:${attempt}`);
      if (attempt === 1) throw haltError();
      return 'ok';
    });
    const startDegraded = vi.fn().mockImplementation(() => {
      calls.push('startDegraded');
      return handle;
    });
    const setReadiness = vi.fn().mockImplementation((r: string) => calls.push(`readiness:${r}`));
    const awaitRetry = vi.fn().mockImplementation(async () => {
      calls.push('awaitRetry:start');
      // Resolve the stop() promise only AFTER awaitRetry itself resolves,
      // proving stop() genuinely gates the next runBootstrap call rather
      // than racing it.
      setTimeout(() => stopResolve?.(), 0);
      calls.push('awaitRetry:resolve');
    });

    const result = await runBootstrapWithDegradeOpen({
      runBootstrap,
      startDegraded,
      setReadiness,
      awaitRetry,
    });

    expect(result).toBe('ok');
    expect(calls).toEqual([
      'readiness:bootstrapping',
      'runBootstrap:1',
      'startDegraded',
      'readiness:degraded',
      'awaitRetry:start',
      'awaitRetry:resolve',
      'stop:called',
      'stop:resolved',
      'readiness:bootstrapping',
      'runBootstrap:2',
      'readiness:ready',
    ]);
  });

  it('does not flip readiness to degraded when startDegraded returns null (integrity halt or construction failure)', async () => {
    const calls: string[] = [];
    let attempt = 0;
    const runBootstrap = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw haltError();
      return 'ok';
    });
    const setReadiness = vi.fn().mockImplementation((r: string) => calls.push(r));

    await runBootstrapWithDegradeOpen({
      runBootstrap,
      startDegraded: () => null,
      setReadiness,
      awaitRetry: async () => {},
    });

    expect(calls).toEqual(['bootstrapping', 'bootstrapping', 'ready']);
    expect(calls).not.toContain('degraded');
  });

  it('does not call stop() when startDegraded returned null', async () => {
    let attempt = 0;
    const runBootstrap = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw haltError();
      return 'ok';
    });
    const stop = vi.fn();

    // startDegraded returns null on the only halt, so stop must never fire.
    await runBootstrapWithDegradeOpen({
      runBootstrap,
      startDegraded: () => null,
      setReadiness: () => {},
      awaitRetry: async () => {},
    });

    expect(stop).not.toHaveBeenCalled();
  });

  it('propagates any error that is not SetupBootstrapHalted', async () => {
    const boom = new Error('unexpected');
    const runBootstrap = vi.fn().mockRejectedValue(boom);

    await expect(
      runBootstrapWithDegradeOpen({
        runBootstrap,
        startDegraded: () => null,
        setReadiness: () => {},
        awaitRetry: async () => {},
      }),
    ).rejects.toBe(boom);
  });

  it('passes the halt envelope through to both startDegraded and awaitRetry', async () => {
    const env = buildEnvelope({ code: 'bootstrap_incomplete', message: 'no service ready' });
    let attempt = 0;
    const runBootstrap = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new SetupBootstrapHalted(env);
      return 'ok';
    });
    const startDegraded = vi.fn().mockReturnValue(null);
    const awaitRetry = vi.fn().mockResolvedValue(undefined);

    await runBootstrapWithDegradeOpen({
      runBootstrap,
      startDegraded,
      setReadiness: () => {},
      awaitRetry,
    });

    expect(startDegraded).toHaveBeenCalledWith(env);
    expect(awaitRetry).toHaveBeenCalledWith(env);
  });

  it('retries across multiple halts before eventually succeeding', async () => {
    let attempt = 0;
    const runBootstrap = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt < 3) throw haltError();
      return 'finally-ok';
    });

    const result = await runBootstrapWithDegradeOpen({
      runBootstrap,
      startDegraded: () => null,
      setReadiness: () => {},
      awaitRetry: async () => {},
    });

    expect(result).toBe('finally-ok');
    expect(runBootstrap).toHaveBeenCalledTimes(3);
  });
});
