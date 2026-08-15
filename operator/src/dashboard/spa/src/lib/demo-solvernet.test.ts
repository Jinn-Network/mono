import { describe, expect, it } from 'vitest';
import type { SolverNetManifestSummary } from '../../../../api/contract/index.js';
import {
  DEMO_CONTRACT_ID,
  isDemoSolverNet,
  isInternalSolverNet,
} from './demo-solvernet.js';

function summary(
  overrides: Partial<SolverNetManifestSummary>,
): SolverNetManifestSummary {
  return {
    manifestCid: 'bafybeiaaa',
    solverNetId: 'agent5474_swe-rebench-v2-v1_aaaaaaaa',
    name: 'SWE-rebench v2',
    network: 'base-sepolia',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAfABCDEF0123456789abcdef0123456789B5CF',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T00:00:00Z',
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    solutionPriceWei: '10000000000',
    verdictPriceWei: '5000000000',
    openRoles: ['solver', 'evaluator'],
    anchorBlock: 1,
    ...overrides,
  };
}

describe('demo-solvernet predicates', () => {
  it('exposes swe-rebench-v2 as the canonical demo contractId', () => {
    expect(DEMO_CONTRACT_ID).toBe('swe-rebench-v2');
  });

  it('isDemoSolverNet is true for a launched swe-rebench-v2 net', () => {
    expect(isDemoSolverNet(summary({}))).toBe(true);
  });

  it('isDemoSolverNet is false for a non-launched swe-rebench-v2 net', () => {
    expect(isDemoSolverNet(summary({ status: 'paused' }))).toBe(false);
  });

  it('isDemoSolverNet is false for a launched non-demo net', () => {
    expect(isDemoSolverNet(summary({ contractId: 'prediction' }))).toBe(false);
  });

  it('isInternalSolverNet is true for a smoke-named net (case-insensitive)', () => {
    expect(
      isInternalSolverNet(
        summary({ contractId: 'prediction', name: 'SMOKE-e2e-throwaway' }),
      ),
    ).toBe(true);
  });

  it('isInternalSolverNet is false for a normal net', () => {
    expect(
      isInternalSolverNet(summary({ contractId: 'prediction', name: 'Prediction Markets' })),
    ).toBe(false);
  });

  it('never treats the canonical demo net as internal even if its name has smoke', () => {
    expect(isInternalSolverNet(summary({ name: 'smoke SWE-rebench v2' }))).toBe(false);
  });
});
