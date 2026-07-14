import { describe, it, expect } from 'vitest';
import { effortFlag } from '../../src/dispatcher/dispatch.js';
import type { Effort } from '../../src/dispatcher/types.js';

// ---------------------------------------------------------------------------
// #1673 — route the dispatched session --effort from the board Effort field.
//
// The mapping is a pure lowercase identity: board `Low→low`, `Medium→medium`,
// `High→high`, `XHigh→xhigh`, `Max→max`. Unset (null) → no flag (the CLI
// default applies). effortFlag is the exported pure helper the spawn site uses.
// ---------------------------------------------------------------------------

describe('effortFlag', () => {
  const cases: Array<[Effort, string]> = [
    ['Low', 'low'],
    ['Medium', 'medium'],
    ['High', 'high'],
    ['XHigh', 'xhigh'],
    ['Max', 'max'],
  ];

  for (const [board, tier] of cases) {
    it(`maps board Effort ${board} → ['--effort', '${tier}']`, () => {
      expect(effortFlag(board)).toEqual(['--effort', tier]);
    });
  }

  it('maps unset Effort (null) → [] (no flag, CLI default applies)', () => {
    expect(effortFlag(null)).toEqual([]);
  });
});
