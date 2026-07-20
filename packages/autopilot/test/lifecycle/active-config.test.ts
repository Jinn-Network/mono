import { describe, expect, it } from 'vitest';
import { explicitEnvironmentFlag } from '../../src/lifecycle/active-config.js';

describe('active runtime configuration', () => {
  it('keeps rollout flags disabled unless explicitly set to true', () => {
    expect(explicitEnvironmentFlag(undefined, 'JINN_AUTOPILOT_CLEANUP_ENABLED'))
      .toBe(false);
    expect(explicitEnvironmentFlag('', 'JINN_AUTOPILOT_CLEANUP_ENABLED'))
      .toBe(false);
    expect(explicitEnvironmentFlag('false', 'JINN_AUTOPILOT_CLEANUP_ENABLED'))
      .toBe(false);
    expect(explicitEnvironmentFlag('true', 'JINN_AUTOPILOT_CLEANUP_ENABLED'))
      .toBe(true);
  });

  it('fails closed on misspelled or surprising flag values', () => {
    expect(() => explicitEnvironmentFlag(
      '1',
      'JINN_AUTOPILOT_CLEANUP_ENABLED',
    )).toThrow('must be true or false');
  });
});
