import { describe, expect, it } from 'vitest';
import { buildDaemonStartupInfo } from '../../src/daemon/daemon-startup-info.js';

function baseInput() {
  return {
    pid: 123,
    network: 'testnet' as const,
    apiPort: 7331,
    masterAddress: `0x${'11'.repeat(20)}` as `0x${string}`,
    safeAddress: `0x${'22'.repeat(20)}` as `0x${string}`,
    mechAddress: `0x${'33'.repeat(20)}` as `0x${string}`,
    serviceIndex: 1,
    serviceId: 7,
    effectiveMode: 'legacy' as const,
    implVersion: '0.2.5',
    now: () => new Date('2026-08-04T00:00:00.000Z'),
  };
}

describe('buildDaemonStartupInfo (#2380)', () => {
  it('derives phase from network and carries effectiveMode/implVersion from the caller-resolved values', () => {
    expect(buildDaemonStartupInfo(baseInput())).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-08-04T00:00:00.000Z',
      kind: 'daemon_started',
      pid: 123,
      network: 'testnet',
      phase: 'phase-1b',
      apiPort: 7331,
      masterAddress: `0x${'11'.repeat(20)}`,
      safeAddress: `0x${'22'.repeat(20)}`,
      mechAddress: `0x${'33'.repeat(20)}`,
      serviceIndex: 1,
      serviceId: 7,
      effectiveMode: 'legacy',
      implVersion: '0.2.5',
    });
  });

  it('never re-derives effectiveMode — it passes the caller-supplied resolver value through unchanged', () => {
    const info = buildDaemonStartupInfo({ ...baseInput(), effectiveMode: 'native-v1' });
    expect(info.effectiveMode).toBe('native-v1');
  });

  it('maps mainnet network to phase-0', () => {
    const info = buildDaemonStartupInfo({ ...baseInput(), network: 'mainnet' });
    expect(info.phase).toBe('phase-0');
  });
});
