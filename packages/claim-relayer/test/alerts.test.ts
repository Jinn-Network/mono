import { describe, expect, it, vi } from 'vitest';
import { AlertNotifier } from '../src/alerts.js';

const SIGNER = '0x1111111111111111111111111111111111111111' as const;
const WEBHOOK = 'https://hooks.example/webhook/super-secret-token';

function ctx(overrides: Partial<{
  checkpoint: string;
  consecutivePollsWithoutProgress: number;
  lastErrorMessage: string | null;
}> = {}) {
  return {
    checkpoint: '100',
    consecutivePollsWithoutProgress: 0,
    lastErrorMessage: null,
    ...overrides,
  };
}

const ALL_FALSE = { notReady: false, lastError: false, staleCheckpoint: false };

function okFetch() {
  return vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
}

describe('AlertNotifier', () => {
  it('never calls fetch and logs once when no webhook is configured', async () => {
    const fetchFn = okFetch();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notifier = new AlertNotifier({ webhookUrl: undefined, signerAddress: SIGNER, fetchFn });

    await notifier.evaluate({ ...ALL_FALSE, staleCheckpoint: true }, ctx({ consecutivePollsWithoutProgress: 3 }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('fires once on false->true and de-dups while the condition persists', async () => {
    const fetchFn = okFetch();
    const notifier = new AlertNotifier({ webhookUrl: WEBHOOK, signerAddress: SIGNER, fetchFn });

    await notifier.evaluate({ ...ALL_FALSE, staleCheckpoint: true }, ctx({ consecutivePollsWithoutProgress: 3 }));
    await notifier.evaluate({ ...ALL_FALSE, staleCheckpoint: true }, ctx({ consecutivePollsWithoutProgress: 4 }));
    await notifier.evaluate({ ...ALL_FALSE, staleCheckpoint: true }, ctx({ consecutivePollsWithoutProgress: 5 }));

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('POSTs a redacted JSON body and never leaks the webhook URL', async () => {
    const fetchFn = okFetch();
    const notifier = new AlertNotifier({ webhookUrl: WEBHOOK, signerAddress: SIGNER, fetchFn });

    await notifier.evaluate(
      { ...ALL_FALSE, lastError: true },
      ctx({ consecutivePollsWithoutProgress: 0, lastErrorMessage: 'HTTP request failed. URL: https://key.example/rpc-secret' }),
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.condition).toBe('lastError');
    expect(body.message).toContain('[redacted-url]');
    expect(body.message).not.toContain('key.example');
    expect(body.checkpoint).toBe('100');
    expect(body.consecutivePollsWithoutProgress).toBe(0);
    expect(body.signerAddress).toBe(SIGNER);
    expect(typeof body.ts).toBe('string');
    // The webhook URL itself must never appear inside the POST body.
    expect(init.body).not.toContain('super-secret-token');
  });

  it('emits a single recovered event on true->false and re-arms', async () => {
    const fetchFn = okFetch();
    const notifier = new AlertNotifier({ webhookUrl: WEBHOOK, signerAddress: SIGNER, fetchFn });

    await notifier.evaluate({ ...ALL_FALSE, staleCheckpoint: true }, ctx({ consecutivePollsWithoutProgress: 3 }));
    await notifier.evaluate({ ...ALL_FALSE, staleCheckpoint: false }, ctx({ consecutivePollsWithoutProgress: 0 }));
    await notifier.evaluate({ ...ALL_FALSE, staleCheckpoint: true }, ctx({ consecutivePollsWithoutProgress: 3 }));

    expect(fetchFn).toHaveBeenCalledTimes(3);
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const bodies = calls.map((c) => JSON.parse(c[1].body as string));
    expect(bodies[0].condition).toBe('staleCheckpoint');
    expect(bodies[0].message).not.toContain('recovered');
    expect(bodies[1].message.toLowerCase()).toContain('recovered');
    expect(bodies[2].condition).toBe('staleCheckpoint');
    expect(bodies[2].message).not.toContain('recovered');
  });

  it('tracks the three conditions independently', async () => {
    const fetchFn = okFetch();
    const notifier = new AlertNotifier({ webhookUrl: WEBHOOK, signerAddress: SIGNER, fetchFn });

    await notifier.evaluate(
      { notReady: true, lastError: true, staleCheckpoint: true },
      ctx({ consecutivePollsWithoutProgress: 3, lastErrorMessage: 'boom' }),
    );

    // Three distinct conditions => three distinct alerts on the first eval.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const conditions = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse(c[1].body as string).condition)
      .sort();
    expect(conditions).toEqual(['lastError', 'not-ready', 'staleCheckpoint']);
  });

  it('never throws when the webhook POST rejects', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notifier = new AlertNotifier({ webhookUrl: WEBHOOK, signerAddress: SIGNER, fetchFn });

    await expect(
      notifier.evaluate({ ...ALL_FALSE, staleCheckpoint: true }, ctx({ consecutivePollsWithoutProgress: 3 })),
    ).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it('bounds a hung webhook via the AbortSignal timeout and never wedges the caller', async () => {
    // fire() bounds the webhook with a setTimeout-driven AbortController, so
    // advanceTimersByTimeAsync drives the abort instead of a real 10s wait.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A webhook that accepts the connection but never replies on its own. It
    // only settles when the AbortSignal passed by fire() aborts — i.e. the
    // fetch hangs forever unless the timeout interrupts it. Without the timeout
    // this promise never resolves and evaluate() wedges the poll loop forever.
    const fetchFn = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles -> exposes a missing timeout
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notifier = new AlertNotifier({ webhookUrl: WEBHOOK, signerAddress: SIGNER, fetchFn });

    const evaluatePromise = notifier.evaluate(
      { ...ALL_FALSE, staleCheckpoint: true },
      ctx({ consecutivePollsWithoutProgress: 3 }),
    );

    // Advance past the webhook timeout; the AbortSignal.timeout must fire,
    // abort the hung fetch, and let evaluate() resolve without rejecting.
    await vi.advanceTimersByTimeAsync(11_000);

    await expect(evaluatePromise).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);

    errSpy.mockRestore();
    vi.useRealTimers();
  });
});
