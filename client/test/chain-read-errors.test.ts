import { describe, expect, it } from 'vitest';
import { isTransientEthReadError } from '../src/chain-read-errors.js';

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
