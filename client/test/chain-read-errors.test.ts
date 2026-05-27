import { describe, expect, it, vi } from 'vitest';
import {
  isRateLimitedEthReadError,
  isTransientEthReadError,
  withTransientEthReadRetry,
} from '../src/chain-read-errors.js';

describe('isTransientEthReadError', () => {
  it('returns true for common RPC transport signals', () => {
    expect(isTransientEthReadError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isTransientEthReadError(new Error('Internal JSON-RPC error. (-32603)'))).toBe(true);
    expect(isTransientEthReadError(new Error('fetch failed'))).toBe(true);
  });

  it('returns false for opaque revert strings', () => {
    expect(isTransientEthReadError(new Error('execution reverted'))).toBe(false);
  });

  it('returns true for ethers-style server error codes', () => {
    expect(isTransientEthReadError({ code: 'SERVER_ERROR', message: 'bad gateway' })).toBe(true);
    expect(isTransientEthReadError({ code: 'TIMEOUT', message: 'x' })).toBe(true);
  });
});

describe('isRateLimitedEthReadError', () => {
  it('returns true only for 429 / rate-limit signals', () => {
    expect(isRateLimitedEthReadError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitedEthReadError(new Error('HTTP request failed: rate limit exceeded'))).toBe(true);
    expect(isRateLimitedEthReadError(new Error('the endpoint returned: Too Many Requests'))).toBe(true);
  });

  it('returns false for other transient failures it must not over-claim', () => {
    // These are transient but NOT rate limits — they must classify as
    // undefined so the UI does not tell the operator to swap their RPC key.
    expect(isRateLimitedEthReadError(new Error('fetch failed'))).toBe(false);
    expect(isRateLimitedEthReadError(new Error('Internal JSON-RPC error. (-32603)'))).toBe(false);
    expect(isRateLimitedEthReadError(new Error('502 bad gateway'))).toBe(false);
    expect(isRateLimitedEthReadError(new Error('request timed out'))).toBe(false);
    expect(isRateLimitedEthReadError({ code: 'TIMEOUT', message: 'x' })).toBe(false);
  });

  it('returns false for opaque revert strings', () => {
    expect(isRateLimitedEthReadError(new Error('execution reverted'))).toBe(false);
  });
});

describe('withTransientEthReadRetry', () => {
  it('returns immediately when the first attempt succeeds', async () => {
    const fn = vi.fn(async () => 'ok');
    const sleepFn = vi.fn(async () => undefined);

    await expect(withTransientEthReadRetry(fn, { sleepFn })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('retries transient failures with the configured backoff delays', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce('ok');
    const sleepFn = vi.fn(async () => undefined);

    await expect(withTransientEthReadRetry(fn, { sleepFn })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn.mock.calls[0]?.[0]).toBe(250);
    expect(sleepFn.mock.calls[1]?.[0]).toBe(500);
  });

  it('throws after max attempts when every failure is transient', async () => {
    const err = new Error('HTTP 429: Too Many Requests');
    const fn = vi.fn(async () => {
      throw err;
    });
    const sleepFn = vi.fn(async () => undefined);

    await expect(withTransientEthReadRetry(fn, { sleepFn })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn.mock.calls[0]?.[0]).toBe(250);
    expect(sleepFn.mock.calls[1]?.[0]).toBe(500);
  });

  it('does not retry non-transient errors', async () => {
    const err = new Error('execution reverted');
    const fn = vi.fn(async () => {
      throw err;
    });
    const sleepFn = vi.fn(async () => undefined);

    await expect(withTransientEthReadRetry(fn, { sleepFn })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
