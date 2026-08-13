import { describe, expect, it } from 'vitest';
import {
  activeCleanupEnabled,
  attemptGraceMs,
  autopilotExecutionBackend,
  autopilotDiskFloorBytes,
  explicitEnvironmentFlag,
  marketplaceSolverNetManifestCid,
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

  it('selects the V2 execution backend independently and defaults to local', () => {
    expect(autopilotExecutionBackend(undefined)).toBe('local');
    expect(autopilotExecutionBackend('')).toBe('local');
    expect(autopilotExecutionBackend('local')).toBe('local');
    expect(() => autopilotExecutionBackend('daemon')).toThrow(
      /JINN_AUTOPILOT_EXECUTION_BACKEND.*local.*marketplace/i,
    );
  });

  // One-swap R3b (issue #2494) retired `jinn tasks observe-autopilot-delivery`,
  // the marketplace backend's only delivery-confirmation path. The refusal must
  // happen HERE, at parse — a run that got as far as posting a Task would have
  // spent escrow it could never confirm.
  it('refuses the retired marketplace backend at parse, before any Task is posted', () => {
    expect(() => autopilotExecutionBackend('marketplace')).toThrow(
      /marketplace is retired/i,
    );
    expect(() => autopilotExecutionBackend('marketplace')).toThrow(/#2494/);
  });

  it('parses an optional explicit marketplace manifest CID and rejects empty values', () => {
    expect(marketplaceSolverNetManifestCid(undefined)).toBeUndefined();
    expect(marketplaceSolverNetManifestCid('bafy-explicit-manifest'))
      .toBe('bafy-explicit-manifest');
    expect(() => marketplaceSolverNetManifestCid('')).toThrow(
      /JINN_AUTOPILOT_MARKETPLACE_SOLVERNET_MANIFEST_CID.*non-empty/i,
    );
    expect(() => marketplaceSolverNetManifestCid('  ')).toThrow(
      /JINN_AUTOPILOT_MARKETPLACE_SOLVERNET_MANIFEST_CID.*non-empty/i,
    );
    expect(() => marketplaceSolverNetManifestCid(' bafy-cid')).toThrow(
      /JINN_AUTOPILOT_MARKETPLACE_SOLVERNET_MANIFEST_CID.*whitespace/i,
    );
  });
});
