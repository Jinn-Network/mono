import { describe, expect, it } from 'vitest';
import {
  FleetStateSchema,
  ServiceStateSchema,
  createDefaultFleetState,
  createDefaultServiceState,
} from '../../src/earning/types.js';
import type { FleetState, ServiceState } from '../../src/earning/types.js';

describe('Fleet state types', () => {
  it('creates a default fleet state', () => {
    const state = createDefaultFleetState('base');
    expect(state.master_address).toBeNull();
    expect(state.chain).toBe('base');
    expect(state.staking_mode).toBe('standard');
    expect(state.services).toEqual([]);
  });

  it('validates a fleet state with services', () => {
    const state = createDefaultFleetState('base');
    state.master_address = '0x1234567890abcdef1234567890abcdef12345678';
    state.services = [
      createDefaultServiceState(1, '0xabcdef1234567890abcdef1234567890abcdef12'),
    ];

    const result = FleetStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('creates a default service state at given index', () => {
    const svc = createDefaultServiceState(1, '0xabcdef1234567890abcdef1234567890abcdef12');
    expect(svc.index).toBe(1);
    expect(svc.agent_address).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    expect(svc.step).toBe('awaiting_stake');
    expect(svc.safe_address).toBeNull();
    expect(svc.service_id).toBeNull();
    expect(svc.mech_address).toBeNull();
  });

  it('rejects service with index 0', () => {
    const result = ServiceStateSchema.safeParse({
      index: 0,
      agent_address: '0x1234567890abcdef1234567890abcdef12345678',
      safe_address: null,
      service_id: null,
      mech_address: null,
      staking_address: null,
      step: 'awaiting_stake',
      error: null,
    });
    expect(result.success).toBe(false);
  });
});
