import { describe, expect, it } from 'vitest';
import { gasSeverity } from './gas-severity.js';

describe('gasSeverity boundary (#1296, handbook AI workflow rule 7 — boundary tests for numeric gates)', () => {
  it('balance exactly equal to minEthWei is NOT blocking (strict less-than)', () => {
    expect(
      gasSeverity({
        balanceWei: '1000000000000000',
        minEthWei: '1000000000000000',
        runwayDaysExcess: '1',
      }),
    ).toBe('warning');
  });

  it('balance one wei below minEthWei is blocking', () => {
    expect(
      gasSeverity({
        balanceWei: '999999999999999',
        minEthWei: '1000000000000000',
        runwayDaysExcess: '1',
      }),
    ).toBe('blocking');
  });
});
