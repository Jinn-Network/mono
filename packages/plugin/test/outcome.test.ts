import { describe, expect, it } from 'vitest';
import { degraded, ok, unavailable } from '../src/outcome.js';

describe('PortResult helpers', () => {
  it('ok() wraps a value with status ok', () => {
    expect(ok(42)).toEqual({ status: 'ok', value: 42 });
  });

  it('degraded() carries a reason and optional value', () => {
    expect(degraded('cache-miss', [1, 2])).toEqual({ status: 'degraded', reason: 'cache-miss', value: [1, 2] });
    expect(degraded('cache-miss')).toEqual({ status: 'degraded', reason: 'cache-miss', value: undefined });
  });

  it('unavailable() carries only a reason', () => {
    expect(unavailable('offline')).toEqual({ status: 'unavailable', reason: 'offline' });
  });
});
