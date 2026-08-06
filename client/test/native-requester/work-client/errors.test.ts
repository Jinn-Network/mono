import { describe, expect, it } from 'vitest';
import {
  REQUESTER_ERROR_CATEGORIES,
  RequesterError,
  isRequesterError,
} from '../../../src/native-requester/work-client/errors.js';

describe('work-client error taxonomy', () => {
  it('carries category, code and cause', () => {
    const cause = new Error('underlying');
    const err = new RequesterError('funds', 'safe-underfunded', 'Safe is short', { cause });
    expect(err.category).toBe('funds');
    expect(err.code).toBe('safe-underfunded');
    expect(err.name).toBe('RequesterError');
    expect(err.cause).toBe(cause);
  });

  it('is narrowable and rejects non-errors', () => {
    expect(isRequesterError(new RequesterError('venue', 'no-chain-config', 'x'))).toBe(true);
    expect(isRequesterError(new Error('plain'))).toBe(false);
    expect(isRequesterError('funds')).toBe(false);
  });

  it('declares the closed category set in preflight order', () => {
    expect(REQUESTER_ERROR_CATEGORIES).toEqual([
      'config',
      'funds',
      'venue',
      'target',
      'freshness',
      'documents',
      'broadcast',
      'delivery',
      'adoption',
      'settlement',
    ]);
  });
});
