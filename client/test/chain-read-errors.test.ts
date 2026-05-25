import { describe, expect, it } from 'vitest';
import { isRateLimitedEthReadError, isTransientEthReadError } from '../src/chain-read-errors.js';

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
