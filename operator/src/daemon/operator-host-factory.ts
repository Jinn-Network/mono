import type { OperatorVerticalDecision } from './native-vertical-mode.js';

export interface OperatorHost {
  start(): void | Promise<void>;
  health(): unknown | Promise<unknown>;
  close(): void | Promise<void>;
}

export interface OperatorHostFactoryInput<T extends OperatorHost> {
  readonly decision: OperatorVerticalDecision;
  readonly buildLegacy: () => T | Promise<T>;
  readonly buildNative: () => T | Promise<T>;
}

/** Selects exactly one product graph. A native construction error is never a legacy fallback signal. */
export async function buildOperatorHost<T extends OperatorHost>(
  input: OperatorHostFactoryInput<T>,
): Promise<T> {
  return input.decision.effectiveMode === 'native-v1'
    ? input.buildNative()
    : input.buildLegacy();
}
