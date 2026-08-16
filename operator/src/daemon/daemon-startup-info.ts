/**
 * `daemon_started` payload assembly for `main.ts` (#2380).
 *
 * Extracted into its own module so `effectiveMode`/`implVersion` are unit-testable without
 * importing `main.ts` itself, which has heavy import-time side effects (loads config from disk,
 * resolves chain config) that make it impractical to exercise directly in a test file.
 */

import type { OperatorVerticalDecision, OperatorVerticalMode } from './native-vertical-mode.js';

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
   * The daemon's resolved product mode (#2380). `main.ts` computes this via
   * `resolveMainEntryEffectiveMode`, which clamps to `'legacy'`. After D5 there is
   * one `jinn run` entry; native composition is `compositionMode` inside this
   * graph, not a second file. Never a raw, unclamped re-derivation.
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

export interface MainEntryEffectiveMode {
  /** Always 'legacy' — see the function docstring below. */
  readonly effectiveMode: 'legacy';
  /** Set when the resolver disagreed; the caller should log this loudly. `undefined` in the
   *  ordinary case (no disagreement, nothing to say). */
  readonly warning: string | undefined;
}

/**
 * `main.ts` is the only `jinn run` entry (D5). Native composition is selected inside it via
 * `compositionMode`, not a second file. Reporting a leftover `native-v1` verticalMode as
 * `effectiveMode` would mislabel this graph as the retired parallel entry — the one
 * direction that must never happen for a field a Phase D collector uses to exempt an instance
 * from scrutiny. This clamps the reported mode to `'legacy'` unconditionally and surfaces a
 * loud-log warning when the resolver actually disagreed, rather than trusting the raw decision.
 */
export function resolveMainEntryEffectiveMode(decision: OperatorVerticalDecision): MainEntryEffectiveMode {
  if (decision.effectiveMode === 'legacy') return { effectiveMode: 'legacy', warning: undefined };
  return {
    effectiveMode: 'legacy',
    warning: `resolveConfiguredOperatorVerticalMode selected effective mode '${decision.effectiveMode}' `
      + `(readiness=${decision.readiness}), but main.ts always runs the legacy graph regardless. `
      + `Reporting effectiveMode as 'legacy'. This means a caller (e.g. 'jinn quickstart') reached `
      + `main.ts without routing through the resolver first — use 'jinn run' for native-v1 configurations.`,
  };
}
