import { describe, expect, it } from 'vitest';
import { nextFleetServiceIndex } from '../../src/earning/next-service-index.js';

describe('nextFleetServiceIndex', () => {
  it('returns 1 for an empty fleet', () => {
    expect(nextFleetServiceIndex([])).toBe(1);
  });

  it('returns max index + 1 when indices are contiguous', () => {
    expect(nextFleetServiceIndex([{ index: 1 }, { index: 2 }])).toBe(3);
  });

  it('returns max index + 1 after a middle row was removed (gap)', () => {
    expect(nextFleetServiceIndex([{ index: 1 }, { index: 3 }])).toBe(4);
  });
});
