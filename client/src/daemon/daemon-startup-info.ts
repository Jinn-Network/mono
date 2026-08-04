/**
 * `daemon_started` payload assembly for `main.ts` (#2380).
 *
 * Extracted into its own module so `effectiveMode`/`implVersion` are unit-testable without
 * importing `main.ts` itself, which has heavy import-time side effects (loads config from disk,
 * resolves chain config) that make it impractical to exercise directly in a test file.
 */

import type { OperatorVerticalMode } from './native-vertical-mode.js';

export interface DaemonStartupInfo {
  schemaVersion: 1;
  generatedAt: string;
  kind: 'daemon_started';
  pid: number;
  network: 'testnet' | 'mainnet';
  phase: 'phase-1b' | 'phase-0';
  apiPort: number;
  masterAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress: `0x${string}`;
  serviceIndex: number;
  serviceId: number | null;
  /**
   * The daemon's resolved product mode (#2380). Computed by `main.ts` via
   * `resolveConfiguredOperatorVerticalMode` — the same resolver `cli/commands/run.ts` uses to
   * route between `main.ts` and `native-main.ts` — never re-derived here.
   */
  effectiveMode: OperatorVerticalMode;
  /** This build's implementation version (`buildInfo.implVersion`). */
  implVersion: string;
}

export function buildDaemonStartupInfo(input: {
  readonly pid: number;
  readonly network: 'testnet' | 'mainnet';
  readonly apiPort: number;
  readonly masterAddress: `0x${string}`;
  readonly safeAddress: `0x${string}`;
  readonly mechAddress: `0x${string}`;
  readonly serviceIndex: number;
  readonly serviceId: number | null;
  readonly effectiveMode: OperatorVerticalMode;
  readonly implVersion: string;
  readonly now?: () => Date;
}): DaemonStartupInfo {
  return {
    schemaVersion: 1,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    kind: 'daemon_started',
    pid: input.pid,
    network: input.network,
    phase: input.network === 'testnet' ? 'phase-1b' : 'phase-0',
    apiPort: input.apiPort,
    masterAddress: input.masterAddress,
    safeAddress: input.safeAddress,
    mechAddress: input.mechAddress,
    serviceIndex: input.serviceIndex,
    serviceId: input.serviceId,
    effectiveMode: input.effectiveMode,
    implVersion: input.implVersion,
  };
}
