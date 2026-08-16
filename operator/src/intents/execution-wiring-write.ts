/**
 * Execution-wiring write intent (headless §4.1 / §10).
 *
 * Both `PUT /v1/operator/execution-wiring` and `jinn wiring set` converge here.
 * Restart-required: wiring is not hot-applied.
 */
import { persistTopLevelConfigValue } from '../config.js';
import type { ExecutionWiringConfigEntry } from '../config/shape-v2.js';

export interface WriteExecutionWiringInput {
  readonly executionWiring: readonly ExecutionWiringConfigEntry[];
  readonly configPath?: string;
  readonly persist?: typeof persistTopLevelConfigValue;
  readonly notifyRestartRequired?: () => void;
}

export interface WriteExecutionWiringResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verb: 'wiring set';
  readonly restartRequired: true;
  readonly executionWiring: readonly ExecutionWiringConfigEntry[];
}

export function writeExecutionWiringIntent(
  input: WriteExecutionWiringInput,
): WriteExecutionWiringResult {
  const persist = input.persist ?? persistTopLevelConfigValue;
  persist('executionWiring', input.executionWiring, input.configPath);
  input.notifyRestartRequired?.();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'wiring set',
    restartRequired: true,
    executionWiring: input.executionWiring,
  };
}
