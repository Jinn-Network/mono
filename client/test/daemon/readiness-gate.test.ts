import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateClaimByReadiness, _resetReadinessGateMemoForTests } from '../../src/daemon/readiness-gate.js';
import type { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';

function fakeRegistry(ready: boolean, reason?: string): HarnessReadinessRegistry {
  return {
    isReadyForClaim: vi.fn().mockReturnValue({ ready, reason }),
    getSnapshot: vi.fn(),
    refreshNow: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as HarnessReadinessRegistry;
}

beforeEach(() => {
  _resetReadinessGateMemoForTests();
});

describe('gateClaimByReadiness', () => {
  it('proceeds when harness is ready', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const registry = fakeRegistry(true);
    const result = gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    expect(result).toEqual({ proceed: true });
  });

  it('skips when harness is not ready', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const registry = fakeRegistry(false, 'claude not authenticated');
    const result = gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain('claude not authenticated');
    }
  });

  it('logs status-change transitions only (not per tick)', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const registry = fakeRegistry(false, 'first-tick reason');
    gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    expect(logger.warn).toHaveBeenCalledTimes(1);  // only the first transition fires the warn
  });
});
