/**
 * Central place for telemetry log statements
 */

import { workerLogger } from '../../logging/index.js';

/**
 * Log telemetry checkpoint
 */
export function logTelemetryCheckpoint(
  phase: string,
  checkpoint: string,
  data?: Record<string, any>
): void {
  workerLogger.info({ phase, checkpoint, ...data }, `Telemetry checkpoint: ${phase}.${checkpoint}`);
}

/**
 * Log telemetry error
 */
export function logTelemetryError(
  phase: string,
  error: any,
  data?: Record<string, any>
): void {
  workerLogger.error({ phase, error, ...data }, `Telemetry error in phase: ${phase}`);
}

