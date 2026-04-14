import { describe, expect, it } from 'vitest';
import { pickPrimaryMechService } from '../../src/cli/execution-context.js';
import type { ServiceState } from '../../src/earning/types.js';

function svc(partial: Partial<ServiceState> & Pick<ServiceState, 'index' | 'step'>): ServiceState {
  return {
    agent_address: '0x0000000000000000000000000000000000000001',
    safe_address: null,
    service_id: null,
    mech_address: null,
    staking_address: null,
    error: null,
    ...partial,
  };
}

describe('pickPrimaryMechService', () => {
  it('returns the first complete service with safe and mech', () => {
    const a = svc({
      index: 1,
      step: 'complete',
      safe_address: '0x1111111111111111111111111111111111111111',
      mech_address: '0x2222222222222222222222222222222222222222',
    });
    const b = svc({
      index: 2,
      step: 'complete',
      safe_address: '0x3333333333333333333333333333333333333333',
      mech_address: null,
    });
    expect(pickPrimaryMechService([b, a])).toEqual(a);
  });

  it('returns undefined when no eligible service', () => {
    expect(
      pickPrimaryMechService([
        svc({ index: 1, step: 'complete', safe_address: '0x1111111111111111111111111111111111111111' }),
      ]),
    ).toBeUndefined();
  });
});
