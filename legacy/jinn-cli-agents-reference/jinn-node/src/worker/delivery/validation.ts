/**
 * Delivery validation: ensures delivery payload includes required fields
 */

import type { UnclaimedRequest, AgentExecutionResult, FinalStatus, IpfsMetadata } from '../types.js';

/**
 * Delivery context for validation
 */
export interface DeliveryValidationContext {
  requestId: string;
  request: UnclaimedRequest;
  result: AgentExecutionResult;
  finalStatus: FinalStatus;
  metadata: IpfsMetadata;
}

/**
 * Validate delivery context has required fields
 */
export function validateDeliveryContext(context: DeliveryValidationContext): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!context.requestId) {
    errors.push('Missing requestId');
  }

  if (!context.result) {
    errors.push('Missing result');
  } else {
    if (typeof context.result.output !== 'string') {
      errors.push('Result output must be a string');
    }
    if (!context.result.telemetry || typeof context.result.telemetry !== 'object') {
      errors.push('Result telemetry must be an object');
    }
  }

  if (!context.finalStatus) {
    errors.push('Missing finalStatus');
  } else {
    if (!['COMPLETED', 'DELEGATING', 'WAITING', 'FAILED'].includes(context.finalStatus.status)) {
      errors.push(`Invalid finalStatus: ${context.finalStatus.status}`);
    }
  }

  if (!context.metadata) {
    errors.push('Missing metadata');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

