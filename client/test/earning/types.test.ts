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

  it('parses pre-j07 state files that omit ERC-8004 fields (backward compat)', () => {
    // Service rows persisted before the IdentityRegistry mint step landed
    // (jinn-mono-j07) lack agent_id / agent_uri / identity_registry_address /
    // agent_registered_tx / safe_bound_to_agent. The schema must still parse
    // them so existing operators don't get a "reset to default" on upgrade.
    const result = ServiceStateSchema.safeParse({
      index: 1,
      agent_address: '0xabcdef1234567890abcdef1234567890abcdef12',
      safe_address: '0x2222222222222222222222222222222222222222',
      service_id: 42,
      mech_address: '0x3333333333333333333333333333333333333333',
      staking_address: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
      step: 'complete',
      error: null,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agent_id).toBeNull();
    expect(result.data.agent_uri).toBeNull();
    expect(result.data.identity_registry_address).toBeNull();
    expect(result.data.agent_registered_tx).toBeNull();
    expect(result.data.safe_bound_to_agent).toBe(false);
  });

  it('persists the post-j07 fields when set', () => {
    const svc: ServiceState = {
      ...createDefaultServiceState(1, '0xabcdef1234567890abcdef1234567890abcdef12'),
      step: 'agent_registered',
      agent_id: '12345',
      agent_uri: '',
      identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      agent_registered_tx: '0x' + 'aa'.repeat(32),
      safe_bound_to_agent: false,
    };
    const result = ServiceStateSchema.safeParse(svc);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agent_id).toBe('12345');
    expect(result.data.identity_registry_address).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
    expect(result.data.step).toBe('agent_registered');
  });
});
