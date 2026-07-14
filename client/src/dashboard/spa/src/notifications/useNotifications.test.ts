import { describe, expect, it } from 'vitest';
import { mapStatusToDeriveInput } from './useNotifications.js';

describe('mapStatusToDeriveInput — password rotation (#441)', () => {
  it('maps security.lastPasswordRotationAt into passwordRotatedAt', () => {
    const iso = '2024-01-02T03:04:05.000Z';
    const mapped = mapStatusToDeriveInput(
      { security: { lastPasswordRotationAt: iso } },
      {},
      false,
    );
    expect(mapped.passwordRotatedAt).toBe(iso);
  });

  it('maps a null/absent rotation to undefined (notification stays silent)', () => {
    expect(
      mapStatusToDeriveInput({ security: { lastPasswordRotationAt: null } }, {}, false)
        .passwordRotatedAt,
    ).toBeUndefined();
    expect(
      mapStatusToDeriveInput({}, {}, false).passwordRotatedAt,
    ).toBeUndefined();
  });
});

describe('mapStatusToDeriveInput funds mapping (issue #1296)', () => {
  it('maps a low-but-nonzero L2 runway to a low chain entry (not Infinity)', () => {
    const status = {
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '5000000000000000', // 0.005 ETH, > 0
        runwayDaysExcess: '1',
        minEthWei: '1000000000000000',
      },
    };
    const mapped = mapStatusToDeriveInput(status, {}, false);
    const l2 = mapped.funds.chains.find((c) => c.wallet === '0xL2MASTER');
    expect(l2).toBeDefined();
    expect(l2!.runwayDays).toBe(1); // NOT Infinity
    expect(l2!.empty).toBe(false);
  });

  it('flags empty when balanceWei < minEthWei', () => {
    const status = {
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '500000000000000', // 0.0005 ETH
        runwayDaysExcess: '0',
        minEthWei: '1000000000000000', // 0.001 ETH min
      },
    };
    const mapped = mapStatusToDeriveInput(status, {}, false);
    const l2 = mapped.funds.chains.find((c) => c.wallet === '0xL2MASTER');
    expect(l2!.empty).toBe(true);
  });

  it('adds a separate L1 chain entry from l1MasterGas', () => {
    const status = {
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '5000000000000000',
        runwayDaysExcess: '5',
        minEthWei: '1000000000000000',
      },
      l1MasterGas: {
        address: '0xL1MASTER',
        balanceWei: '2000000000000000',
        runwayDaysExcess: '1',
        minEthWei: '1000000000000000',
      },
    };
    const mapped = mapStatusToDeriveInput(status, {}, false);
    expect(mapped.funds.chains.find((c) => c.chain === 'Ethereum Sepolia')?.wallet).toBe(
      '0xL1MASTER',
    );
  });
});

describe('mapStatusToDeriveInput gas gate boundary (#1296, handbook AI workflow rule 7 — boundary tests for numeric gates)', () => {
  it('balance exactly equal to minEthWei is NOT empty (strict less-than)', () => {
    const status = {
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '1000000000000000',
        runwayDaysExcess: '1',
        minEthWei: '1000000000000000',
      },
    };
    const mapped = mapStatusToDeriveInput(status, {}, false);
    const l2 = mapped.funds.chains.find((c) => c.wallet === '0xL2MASTER');
    expect(l2!.empty).toBe(false);
  });

  it('balance one wei below minEthWei is empty', () => {
    const status = {
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '999999999999999',
        runwayDaysExcess: '1',
        minEthWei: '1000000000000000',
      },
    };
    const mapped = mapStatusToDeriveInput(status, {}, false);
    const l2 = mapped.funds.chains.find((c) => c.wallet === '0xL2MASTER');
    expect(l2!.empty).toBe(true);
  });
});
