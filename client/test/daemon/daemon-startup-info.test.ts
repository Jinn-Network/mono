import { describe, expect, it } from 'vitest';
import { buildDaemonStartupInfo, resolveMainEntryEffectiveMode } from '../../src/daemon/daemon-startup-info.js';
import type { OperatorVerticalDecision } from '../../src/daemon/native-vertical-mode.js';

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

// Review IMPORTANT: "quickstart mislabels." jinn quickstart reaches main.ts directly, unrouted —
// unlike jinn run, it never consults resolveConfiguredOperatorVerticalMode to choose an entry
// point. A valid native-v1 config would otherwise make main.ts report effectiveMode: 'native-v1'
// while it actually runs the legacy graph — mislabeling in the direction that must never happen
// for a field a Phase D collector uses to exempt an instance from scrutiny.
describe('resolveMainEntryEffectiveMode (#2380 review IMPORTANT — quickstart mislabeling)', () => {
  it('reports legacy with no warning when the resolver agrees', () => {
    const decision: OperatorVerticalDecision = {
      requestedMode: 'legacy', effectiveMode: 'legacy', readiness: 'explicit-legacy',
    };
    expect(resolveMainEntryEffectiveMode(decision)).toEqual({ effectiveMode: 'legacy', warning: undefined });
  });

  it('clamps to legacy and returns a loud warning when the resolver disagrees (a valid native-v1 config reached main.ts unrouted)', () => {
    const decision: OperatorVerticalDecision = {
      requestedMode: 'native-v1', effectiveMode: 'native-v1', readiness: 'explicit-native-unvalidated',
    };
    const result = resolveMainEntryEffectiveMode(decision);
    expect(result.effectiveMode).toBe('legacy');
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/native-v1/u);
    expect(result.warning).toMatch(/quickstart/u);
  });
});
