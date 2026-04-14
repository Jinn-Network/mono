import { describe, expect, it } from 'vitest';
import {
  displayFleetServiceIndex,
  findServiceByDisplayIndex,
} from '../../src/earning/fleet-display-index.js';
import type { ServiceState } from '../../src/earning/types.js';

function svc(index: number, step: ServiceState['step'] = 'complete'): ServiceState {
  return {
    index,
    agent_address: '0xa',
    safe_address: null,
    service_id: 1,
    mech_address: null,
    staking_address: null,
    step,
    error: null,
  };
}

describe('displayFleetServiceIndex', () => {
  it('maps HD slot 1 to display 0', () => {
    expect(displayFleetServiceIndex(svc(1))).toBe(0);
  });

  it('maps HD slot 3 to display 2', () => {
    expect(displayFleetServiceIndex(svc(3))).toBe(2);
  });
});

describe('findServiceByDisplayIndex', () => {
  it('resolves display index across non-contiguous HD indices', () => {
    const services = [svc(1), svc(3), svc(7)];
    expect(findServiceByDisplayIndex(services, 0)?.index).toBe(1);
    expect(findServiceByDisplayIndex(services, 2)?.index).toBe(3);
    expect(findServiceByDisplayIndex(services, 6)?.index).toBe(7);
    expect(findServiceByDisplayIndex(services, 99)).toBeUndefined();
  });
});
