import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '../../src/lifecycle/types.js';
import { timestampMs } from '../../src/lifecycle/lifecycle.js';

const ACCEPTED = [
  '2026-07-20T03:37:22Z',
  '2026-07-20T03:37:22.000Z',
  '2026-07-20T03:37:22.123Z',
  '2026-07-20T03:37:22+02:00',
];

const REJECTED = [
  '2026-07-20',
  '2026-07-20 03:37:22',
  'not a timestamp',
  '',
];

describe('isoTimestamp', () => {
  it('accepts GitHub\'s second-precision timestamps (production format)', () => {
    expect(() => isoTimestamp('2026-07-20T03:37:22Z')).not.toThrow();
  });

  for (const value of ACCEPTED) {
    it(`accepts ${value}`, () => {
      expect(() => isoTimestamp(value)).not.toThrow();
      expect(isoTimestamp(value)).toBe(value);
    });
  }

  for (const value of REJECTED) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(() => isoTimestamp(value)).toThrow();
    });
  }

  it('accepts internally generated toISOString() output', () => {
    const generated = new Date().toISOString();
    expect(() => isoTimestamp(generated)).not.toThrow();
  });
});

describe('timestampMs', () => {
  it('accepts GitHub\'s second-precision timestamps (production format)', () => {
    expect(timestampMs('2026-07-20T03:37:22Z')).toBe(Date.parse('2026-07-20T03:37:22Z'));
  });

  for (const value of ACCEPTED) {
    it(`accepts ${value}`, () => {
      expect(timestampMs(value)).toBe(Date.parse(value));
    });
  }

  for (const value of REJECTED) {
    it(`fails closed (returns null) for ${JSON.stringify(value)}`, () => {
      expect(timestampMs(value)).toBeNull();
    });
  }
});
