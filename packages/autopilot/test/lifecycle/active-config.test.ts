import { describe, expect, it } from 'vitest';
import {
  activeCleanupEnabled,
  attemptGraceMs,
  autopilotDiskFloorBytes,
  explicitEnvironmentFlag,
} from '../../src/lifecycle/active-config.js';

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

  it('defaults active cleanup on unless explicitly disabled', () => {
    expect(activeCleanupEnabled(undefined, 'JINN_AUTOPILOT_CLEANUP_ENABLED'))
      .toBe(true);
    expect(activeCleanupEnabled('', 'JINN_AUTOPILOT_CLEANUP_ENABLED'))
      .toBe(true);
    expect(activeCleanupEnabled('false', 'JINN_AUTOPILOT_CLEANUP_ENABLED'))
      .toBe(false);
    expect(activeCleanupEnabled('true', 'JINN_AUTOPILOT_CLEANUP_ENABLED'))
      .toBe(true);
  });

  it('parses attempt grace and disk-floor defaults', () => {
    expect(attemptGraceMs(undefined)).toBe(30 * 60 * 1000);
    expect(autopilotDiskFloorBytes(undefined)).toBe(10 * 1024 * 1024 * 1024);
  });

  it('fails closed on misspelled or surprising flag values', () => {
    expect(() => explicitEnvironmentFlag(
      '1',
      'JINN_AUTOPILOT_CLEANUP_ENABLED',
    )).toThrow('must be true or false');
    expect(() => activeCleanupEnabled(
      '1',
      'JINN_AUTOPILOT_CLEANUP_ENABLED',
    )).toThrow('must be true or false');
  });
});
