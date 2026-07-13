import { describe, it, expect } from 'vitest';
import type { VerdictTallyResult, DiscoveryAPI } from '../../src/discovery/types.js';

describe('VerdictTallyResult shape', () => {
  it('has the documented fields', () => {
    const row: VerdictTallyResult = {
      pass: 2,
      fail: 1,
    };
    expect(row.pass).toBe(2);
    expect(row.fail).toBe(1);
  });

  it('DiscoveryAPI declares getVerdictTallies', () => {
    // Type-level assertion: a value typed as DiscoveryAPI must have the method.
    const has = (api: DiscoveryAPI): boolean => typeof api.getVerdictTallies === 'function';
    expect(has).toBeTypeOf('function');
  });

  it('a stub implementing getVerdictTallies type-checks against DiscoveryAPI', () => {
    const stub = {
      getVerdictTallies: async (_args: { taskIds: string[] }) =>
        new Map<string, VerdictTallyResult>(),
    } as Pick<DiscoveryAPI, 'getVerdictTallies'>;
    expect(stub.getVerdictTallies).toBeTypeOf('function');
  });
});
