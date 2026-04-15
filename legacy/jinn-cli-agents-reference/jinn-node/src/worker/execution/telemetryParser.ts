/**
 * Telemetry parsing: extract structured data from agent telemetry
 */

import type { AgentExecutionResult } from '../types.js';

/**
 * Parse telemetry from agent execution result
 * Handles edge cases like PROCESS_ERROR and partial output
 */
export function parseTelemetry(
  result: AgentExecutionResult,
  error?: any
): {
  telemetry: any;
  hasPartialOutput: boolean;
  processExitError: boolean;
} {
  const telemetry = result?.telemetry || {};
  const errorTelemetry = error?.telemetry && typeof error.telemetry === 'object' ? error.telemetry : undefined;
  
  // Check for process exit errors
  const errorMessage = String(error?.message || error?.error || '');
  const stderr = String(error?.error?.stderr || error?.stderr || '');
  const combined = `${errorMessage}\n${stderr}`.toLowerCase();
  const processExitError =
    combined.includes('process exited with code') ||
    (errorTelemetry?.errorType === 'PROCESS_ERROR');

  // Check for partial output
  const hasPartialOutput = Boolean(
    error?.error?.stderr ||
    errorTelemetry?.raw?.partialOutput ||
    (result?.output && error)
  );

  return {
    telemetry: errorTelemetry && Object.keys(errorTelemetry).length > 0 ? errorTelemetry : telemetry,
    hasPartialOutput,
    processExitError,
  };
}

/**
 * Extract output from result or error telemetry
 */
export function extractOutput(result: AgentExecutionResult, error?: any): string {
  if (result?.output) {
    return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  }
  
  if (error?.telemetry?.raw?.partialOutput) {
    return String(error.telemetry.raw.partialOutput);
  }
  
  return '';
}

/**
 * Merge telemetry from error if result telemetry is empty
 */
export function mergeTelemetry(
  result: AgentExecutionResult,
  error?: any
): any {
  if (result?.telemetry && Object.keys(result.telemetry).length > 0) {
    return result.telemetry;
  }
  
  const errorTelemetry = error?.telemetry && typeof error.telemetry === 'object' ? error.telemetry : undefined;
  if (errorTelemetry && Object.keys(errorTelemetry).length > 0) {
    return errorTelemetry;
  }
  
  return {};
}

