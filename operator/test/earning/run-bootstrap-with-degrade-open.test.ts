/**
 * Issue #2407 M3 — the retry-loop ORDERING extracted into
 * `runBootstrapWithDegradeOpen` (earning/bootstrap-run.ts) is independently
 * testable via injected spies, unlike main.ts's inline loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveDegradedStart,
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
      startDegraded: () => ({ kind: 'fail-closed' as const }),
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
      return { kind: 'started' as const, recovery: handle };
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

  it('does not flip readiness to degraded when startDegraded reports fail-closed (integrity halt)', async () => {
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
      startDegraded: () => ({ kind: 'fail-closed' as const }),
      setReadiness,
      awaitRetry: async () => {},
    });

    expect(calls).toEqual(['bootstrapping', 'bootstrapping', 'ready']);
    expect(calls).not.toContain('degraded');
  });

  it('does not attempt stop() when startDegraded did not report a started recovery (#2407 R7 — real assertion, not a spy wired to nothing)', async () => {
    // Two halts: the first startDegraded() call reports fail-closed (no
    // handle); the second returns a real handle. If the implementation ever
    // called `.stop()` on the first (handle-less) result it would throw —
    // the whole runBootstrapWithDegradeOpen call would reject instead of
    // resolving 'ok'. `stop` being called exactly once (for the SECOND
    // halt's real handle) proves the handle-less case was never touched.
    let attempt = 0;
    const stop = vi.fn();
    const startDegraded = vi.fn().mockImplementation(() =>
      attempt === 1
        ? ({ kind: 'fail-closed' as const })
        : ({ kind: 'started' as const, recovery: { stop } }));
    const runBootstrap = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt <= 2) throw haltError();
      return 'ok';
    });

    const result = await runBootstrapWithDegradeOpen({
      runBootstrap,
      startDegraded,
      setReadiness: () => {},
      awaitRetry: async () => {},
    });

    expect(result).toBe('ok');
    expect(startDegraded).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('propagates any error that is not SetupBootstrapHalted', async () => {
    const boom = new Error('unexpected');
    const runBootstrap = vi.fn().mockRejectedValue(boom);

    await expect(
      runBootstrapWithDegradeOpen({
        runBootstrap,
        startDegraded: () => ({ kind: 'fail-closed' as const }),
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
    const startDegraded = vi.fn().mockReturnValue({ kind: 'fail-closed' as const });
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
      startDegraded: () => ({ kind: 'fail-closed' as const }),
      setReadiness: () => {},
      awaitRetry: async () => {},
    });

    expect(result).toBe('finally-ok');
    expect(runBootstrap).toHaveBeenCalledTimes(3);
  });
  // ── #2425 ──────────────────────────────────────────────────────────────
  it("flips readiness to degraded when startDegraded reports 'start-failed' (#2425)", async () => {
    // The regression: an ECONOMIC halt whose recovery-loop startup failed
    // used to be indistinguishable from an integrity halt (both returned
    // `null`), so readiness stayed `bootstrapping` → /ready 503 → a
    // supervisor restart-loops a daemon that is correctly waiting for funding.
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
      startDegraded: () => ({ kind: 'start-failed' as const }),
      setReadiness,
      awaitRetry: async () => {},
    });

    expect(calls).toEqual(['bootstrapping', 'degraded', 'bootstrapping', 'ready']);
  });

  it("does not attempt stop() for a 'start-failed' outcome (#2425)", async () => {
    // `start-failed` carries no handle, so the loop must not try to stop one.
    // A second halt with a real handle proves stop() is still wired.
    let attempt = 0;
    const stop = vi.fn();
    const startDegraded = vi.fn().mockImplementation(() =>
      attempt === 1
        ? ({ kind: 'start-failed' as const })
        : ({ kind: 'started' as const, recovery: { stop } }));
    const runBootstrap = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt <= 2) throw haltError();
      return 'ok';
    });

    const result = await runBootstrapWithDegradeOpen({
      runBootstrap,
      startDegraded,
      setReadiness: () => {},
      awaitRetry: async () => {},
    });

    expect(result).toBe('ok');
    expect(startDegraded).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('resolveDegradedStart (#2425)', () => {
  const economicEnvelope = buildEnvelope({ code: 'funding_required', message: 'needs funds' });
  const integrityEnvelope = buildEnvelope({ code: 'invalid_invocation', message: 'bad config' });

  // `resolveDegradedStart` logs straight to `console` (no injected logger — it
  // is main.ts's boot-path callback and operators grep those lines). Spy so the
  // suite stays quiet AND the operator-facing wording stays asserted.
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("returns 'started' with the recovery handle when the halt is economic and start succeeds", () => {
    const recovery: StoppableRecovery = { stop: vi.fn() };
    const start = vi.fn().mockReturnValue(recovery);

    const outcome = resolveDegradedStart(economicEnvelope, { isEconomic: () => true, start });

    expect(outcome).toEqual({ kind: 'started', recovery });
    expect(start).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns 'fail-closed' without calling start when the halt is integrity-class", () => {
    const start = vi.fn();

    const outcome = resolveDegradedStart(integrityEnvelope, { isEconomic: () => false, start });

    expect(outcome).toEqual({ kind: 'fail-closed' });
    expect(start).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it("returns 'start-failed' — NOT 'fail-closed' — when an economic halt's recovery start throws (#2425)", () => {
    const outcome = resolveDegradedStart(economicEnvelope, {
      isEconomic: () => true,
      start: () => { throw new Error('loop construction blew up'); },
    });

    expect(outcome).toEqual({ kind: 'start-failed' });
    // The failure must be surfaced, and the message must say what readiness
    // the daemon actually lands in — the pre-#2425 message said only
    // "non-fatal", never that readiness is `degraded` with no loops running.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.join(' '));
    expect(message).toContain('degraded');
    expect(message).toContain('loop construction blew up');
  });

  it("fails CLOSED — never throws — when the classifier itself throws", () => {
    // The `startDegraded` contract is that it never throws: an escaping error
    // would unwind runBootstrapWithDegradeOpen and kill the daemon instead of
    // parking it. An unclassifiable halt must not be assumed economic.
    const start = vi.fn();

    const outcome = resolveDegradedStart(economicEnvelope, {
      isEconomic: () => { throw new Error('classifier blew up'); },
      start,
    });

    expect(outcome).toEqual({ kind: 'fail-closed' });
    expect(start).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.join(' '))).toContain('classifier blew up');
  });
});
