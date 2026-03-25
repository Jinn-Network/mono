import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type RequestId = string;

export const DesiredStateSchema = z.object({
  id: z.string().optional(),
  description: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});

export interface DesiredState {
  id: string;
  description: string;
  context?: Record<string, unknown>;
  type?: 'restoration' | 'evaluation';
  attemptId?: string;
  attemptNumber?: number;
  restorationRequestId?: string;
}

export function parseDesiredState(input: unknown): DesiredState {
  const parsed = DesiredStateSchema.parse(input);
  return {
    id: parsed.id ?? randomUUID(),
    description: parsed.description,
    context: parsed.context,
  };
}

export interface RestorationRequest {
  requestId: RequestId;
  desiredState: DesiredState;
  payment?: string;
  timeout?: number;
}

export interface RestorationResult {
  data: string;
  artifacts?: string[];
}

export interface DeliveredResult {
  requestId: RequestId;
  desiredState: DesiredState;
  result: RestorationResult;
  deliveryMechAddress: string;
}
