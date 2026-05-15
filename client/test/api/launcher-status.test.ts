/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { gatherLauncherStatus } from '../../src/api/launcher-status.js';

describe('gatherLauncherStatus', () => {
  it('surfaces the Safe balance returned by launcher deps', async () => {
    const getSafeBalanceWei = vi.fn(() => '123456789');

    const status = await gatherLauncherStatus({
      config: {
        solverNets: {
          prediction: {
            enabled: true,
            solverType: 'prediction.v1',
            roles: ['solving'],
            harness: 'claude-code-learner',
            plugins: [],
          },
        },
      },
      getGeneratorState: () => ({
        cadenceMs: 60_000,
      }),
      getOpenTaskCount: () => 2,
      getReservedBudgetWei: () => '',
      getSafeBalanceWei,
      safeAddress: () => '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      now: () => Date.parse('2026-05-08T12:00:00.000Z'),
    });

    expect(getSafeBalanceWei).toHaveBeenCalledTimes(1);
    expect(status.nets).toHaveLength(1);
    expect(status.nets[0]?.solverType).toBe('prediction.v1');
    expect(status.nets[0]?.budget).toMatchObject({
      safeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      safeBalanceWei: '123456789',
      reservedBudgetWei: '',
    });
  });

  it('preserves unavailable balance as unavailable instead of coercing to zero', async () => {
    const status = await gatherLauncherStatus({
      config: {
        solverNets: {
          prediction: {
            enabled: true,
            solverType: 'prediction.v1',
            roles: ['solving'],
            harness: 'claude-code-learner',
            plugins: [],
          },
        },
      },
      getGeneratorState: () => undefined,
      getOpenTaskCount: () => 0,
      getReservedBudgetWei: () => '',
      getSafeBalanceWei: () => '',
      safeAddress: '0x0000000000000000000000000000000000000000',
      now: () => Date.parse('2026-05-08T12:00:00.000Z'),
    });

    expect(status.nets[0]?.budget.safeBalanceWei).toBe('');
    expect(status.nets[0]?.budget.reservedBudgetWei).toBe('');
  });
});
