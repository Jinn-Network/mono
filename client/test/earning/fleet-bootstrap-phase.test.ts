import { describe, it, expect } from 'vitest';
import {
  FLEET_BOOTSTRAP_PHASES,
  FLEET_BOOTSTRAP_PHASE_INDEX,
  PRE_SERVICE_BOOTSTRAP_PHASES,
} from '../../src/earning/fleet-bootstrap-phase.js';
import { ServiceStepSchema } from '../../src/earning/types.js';

// Issue #2407 / spec §11: one typed fleet bootstrap phase list = pre-service
// phases ∪ ServiceStep, defined once. Today there are two lists at different
// granularities (the endpoint's 14-entry display list and the machine's
// 11-entry ServiceStep) and the endpoint's list silently drops
// `awaiting_stake` — the real sync bug this union repairs.
describe('FLEET_BOOTSTRAP_PHASES', () => {
  it('has exactly 15 members: 4 pre-service phases + all 11 ServiceSteps', () => {
    expect(PRE_SERVICE_BOOTSTRAP_PHASES).toEqual([
      'wallet',
      'safe_predicted',
      'awaiting_funding',
      'safe_deployed',
    ]);
    expect(ServiceStepSchema.options).toHaveLength(11);
    expect(FLEET_BOOTSTRAP_PHASES).toHaveLength(15);
  });

  it('includes awaiting_stake (the step the old display list dropped)', () => {
    expect(FLEET_BOOTSTRAP_PHASES).toContain('awaiting_stake');
  });

  it('places awaiting_stake right after the pre-service phases, before service_created', () => {
    const idx = FLEET_BOOTSTRAP_PHASE_INDEX;
    expect(idx.get('safe_deployed')).toBe(3);
    expect(idx.get('awaiting_stake')).toBe(4);
    expect(idx.get('service_created')).toBe(5);
  });

  it('is exactly the pre-service phases followed by ServiceStepSchema in schema order', () => {
    expect(FLEET_BOOTSTRAP_PHASES).toEqual([
      ...PRE_SERVICE_BOOTSTRAP_PHASES,
      ...ServiceStepSchema.options,
    ]);
  });

  it('has no duplicate members', () => {
    expect(new Set(FLEET_BOOTSTRAP_PHASES).size).toBe(FLEET_BOOTSTRAP_PHASES.length);
  });
});
